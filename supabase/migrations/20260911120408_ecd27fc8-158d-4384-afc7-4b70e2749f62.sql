-- ============ validation helpers ============

CREATE OR REPLACE FUNCTION public.is_valid_policy_node(node jsonb, depth int DEFAULT 0)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  child jsonb;
  op text;
  fld text;
  cop text;
  val jsonb;
BEGIN
  IF depth > 10 THEN RETURN false; END IF;
  IF node IS NULL OR jsonb_typeof(node) <> 'object' THEN RETURN false; END IF;

  IF node ? 'op' THEN
    op := node->>'op';
    IF op NOT IN ('and','or','not') THEN RETURN false; END IF;
    IF jsonb_typeof(node->'children') <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(node->'children') = 0 THEN RETURN false; END IF;
    IF op = 'not' AND jsonb_array_length(node->'children') <> 1 THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(node) k WHERE k NOT IN ('op','children')) > 0 THEN RETURN false; END IF;
    FOR child IN SELECT * FROM jsonb_array_elements(node->'children') LOOP
      IF NOT public.is_valid_policy_node(child, depth + 1) THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
  END IF;

  -- condition node
  IF NOT (node ? 'field' AND node ? 'operator') THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(node) k WHERE k NOT IN ('field','operator','value')) > 0 THEN RETURN false; END IF;

  fld := node->>'field';
  cop := node->>'operator';
  val := node->'value';

  IF fld IN ('is_official_domain','is_primary_document') THEN
    IF cop NOT IN ('is_true','is_false','eq') THEN RETURN false; END IF;
    IF cop = 'eq' THEN
      IF val IS NULL OR jsonb_typeof(val) <> 'boolean' THEN RETURN false; END IF;
    ELSE
      IF node ? 'value' THEN RETURN false; END IF;
    END IF;
    RETURN true;
  ELSIF fld = 'traceability_level' THEN
    IF cop NOT IN ('eq','neq','in','not_in') THEN RETURN false; END IF;
    IF cop IN ('eq','neq') THEN
      IF val IS NULL OR jsonb_typeof(val) <> 'string' THEN RETURN false; END IF;
      RETURN val #>> '{}' IN ('direct_url','domain_indicated','third_party_hosted','untraceable');
    ELSE
      IF val IS NULL OR jsonb_typeof(val) <> 'array' OR jsonb_array_length(val) = 0 THEN RETURN false; END IF;
      RETURN NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(val) e
        WHERE jsonb_typeof(e) <> 'string'
           OR e #>> '{}' NOT IN ('direct_url','domain_indicated','third_party_hosted','untraceable')
      );
    END IF;
  ELSIF fld = 'institution_class' THEN
    IF cop NOT IN ('eq','neq','in','not_in') THEN RETURN false; END IF;
    IF cop IN ('eq','neq') THEN
      IF val IS NULL OR jsonb_typeof(val) <> 'string' THEN RETURN false; END IF;
      RETURN val #>> '{}' IN ('government','intergovernmental','court','academic','professional_body','registered_media','commercial','unknown');
    ELSE
      IF val IS NULL OR jsonb_typeof(val) <> 'array' OR jsonb_array_length(val) = 0 THEN RETURN false; END IF;
      RETURN NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(val) e
        WHERE jsonb_typeof(e) <> 'string'
           OR e #>> '{}' NOT IN ('government','intergovernmental','court','academic','professional_body','registered_media','commercial','unknown')
      );
    END IF;
  END IF;

  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_valid_tier_policy(policy jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  rule jsonb;
BEGIN
  IF policy IS NULL OR jsonb_typeof(policy) <> 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(policy) k WHERE k NOT IN ('schema_version','default_tier','rules')) > 0 THEN RETURN false; END IF;
  IF jsonb_typeof(policy->'schema_version') <> 'number' OR (policy->>'schema_version')::int <> 1 THEN RETURN false; END IF;
  IF jsonb_typeof(policy->'default_tier') <> 'string' OR policy->>'default_tier' NOT IN ('T1','T2','T3','T4','T5') THEN RETURN false; END IF;
  IF jsonb_typeof(policy->'rules') <> 'array' THEN RETURN false; END IF;

  FOR rule IN SELECT * FROM jsonb_array_elements(policy->'rules') LOOP
    IF jsonb_typeof(rule) <> 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(rule) k WHERE k NOT IN ('tier','when')) > 0 THEN RETURN false; END IF;
    IF jsonb_typeof(rule->'tier') <> 'string' OR rule->>'tier' NOT IN ('T1','T2','T3','T4','T5') THEN RETURN false; END IF;
    IF NOT public.is_valid_policy_node(rule->'when', 0) THEN RETURN false; END IF;
  END LOOP;

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_valid_exposure_policy(exposure jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF exposure IS NULL OR jsonb_typeof(exposure) <> 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(exposure) k WHERE k NOT IN ('schema_version','visible_tiers','hidden_tiers_require_promotion')) > 0 THEN RETURN false; END IF;
  IF jsonb_typeof(exposure->'schema_version') <> 'number' OR (exposure->>'schema_version')::int <> 1 THEN RETURN false; END IF;
  IF jsonb_typeof(exposure->'visible_tiers') <> 'array' THEN RETURN false; END IF;
  IF jsonb_typeof(exposure->'hidden_tiers_require_promotion') <> 'array' THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(exposure->'visible_tiers') e
    WHERE jsonb_typeof(e) <> 'string' OR e #>> '{}' NOT IN ('T1','T2','T3','T4','T5')
  ) THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(exposure->'hidden_tiers_require_promotion') e
    WHERE jsonb_typeof(e) <> 'string' OR e #>> '{}' NOT IN ('T1','T2','T3','T4','T5')
  ) THEN RETURN false; END IF;
  -- a tier cannot be both visible and hidden
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(exposure->'visible_tiers') v
    JOIN jsonb_array_elements_text(exposure->'hidden_tiers_require_promotion') h ON v = h
  ) THEN RETURN false; END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.is_valid_policy_node(jsonb, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_valid_tier_policy(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_valid_exposure_policy(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_valid_policy_node(jsonb, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_valid_tier_policy(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_valid_exposure_policy(jsonb) TO authenticated, service_role;

-- ============ research_profiles ============

CREATE TABLE public.research_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON public.research_profiles FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.research_profiles TO authenticated;
GRANT ALL ON public.research_profiles TO service_role;

ALTER TABLE public.research_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read research profiles"
  ON public.research_profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Staff can insert research profiles"
  ON public.research_profiles FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Staff can update research profiles"
  ON public.research_profiles FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE TRIGGER research_profiles_set_updated_at
  BEFORE UPDATE ON public.research_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ research_profile_tier_policies ============

CREATE TABLE public.research_profile_tier_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.research_profiles(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version >= 1),
  policy jsonb NOT NULL CONSTRAINT research_profile_tier_policies_policy_valid CHECK (public.is_valid_tier_policy(policy)),
  exposure jsonb NOT NULL CONSTRAINT research_profile_tier_policies_exposure_valid CHECK (public.is_valid_exposure_policy(exposure)),
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (profile_id, version)
);

CREATE UNIQUE INDEX research_profile_tier_policies_one_active
  ON public.research_profile_tier_policies (profile_id)
  WHERE is_active;

CREATE INDEX research_profile_tier_policies_profile_idx
  ON public.research_profile_tier_policies (profile_id, version DESC);

REVOKE ALL ON public.research_profile_tier_policies FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.research_profile_tier_policies TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.research_profile_tier_policies TO service_role;

ALTER TABLE public.research_profile_tier_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read tier policies"
  ON public.research_profile_tier_policies FOR SELECT TO authenticated USING (true);
CREATE POLICY "Staff can insert tier policies"
  ON public.research_profile_tier_policies FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Staff can toggle active tier policy version"
  ON public.research_profile_tier_policies FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
-- no DELETE policy and no DELETE grant: history is append-only

-- append-only enforcement: only is_active may change
CREATE OR REPLACE FUNCTION public.enforce_tier_policy_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tier policy versions are append-only and cannot be deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.policy IS DISTINCT FROM OLD.policy
     OR NEW.exposure IS DISTINCT FROM OLD.exposure
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'tier policy versions are immutable; only is_active may be changed';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_tier_policy_append_only() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_tier_policy_append_only() TO authenticated, service_role;

CREATE TRIGGER research_profile_tier_policies_append_only_update
  BEFORE UPDATE ON public.research_profile_tier_policies
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tier_policy_append_only();

CREATE TRIGGER research_profile_tier_policies_no_delete
  BEFORE DELETE ON public.research_profile_tier_policies
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tier_policy_append_only();