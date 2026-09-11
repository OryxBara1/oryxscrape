-- Single node interpreter over the whitelisted fact set
CREATE OR REPLACE FUNCTION public.eval_policy_node(node jsonb, facts jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  op text;
  child jsonb;
  fld text;
  cop text;
  val jsonb;
  fact jsonb;
  acc boolean;
BEGIN
  IF node IS NULL OR jsonb_typeof(node) <> 'object' THEN RETURN false; END IF;

  IF node ? 'op' THEN
    op := node->>'op';
    IF op = 'not' THEN
      RETURN NOT public.eval_policy_node(node->'children'->0, facts);
    ELSIF op = 'and' THEN
      acc := true;
      FOR child IN SELECT * FROM jsonb_array_elements(node->'children') LOOP
        acc := acc AND public.eval_policy_node(child, facts);
        IF NOT acc THEN RETURN false; END IF;
      END LOOP;
      RETURN acc;
    ELSIF op = 'or' THEN
      acc := false;
      FOR child IN SELECT * FROM jsonb_array_elements(node->'children') LOOP
        acc := acc OR public.eval_policy_node(child, facts);
        IF acc THEN RETURN true; END IF;
      END LOOP;
      RETURN acc;
    END IF;
    RETURN false;
  END IF;

  fld := node->>'field';
  cop := node->>'operator';
  val := node->'value';
  fact := facts->fld;
  IF fact IS NULL THEN RETURN false; END IF;

  IF cop = 'is_true' THEN RETURN fact = 'true'::jsonb;
  ELSIF cop = 'is_false' THEN RETURN fact = 'false'::jsonb;
  ELSIF cop = 'eq' THEN RETURN fact = val;
  ELSIF cop = 'neq' THEN RETURN fact <> val;
  ELSIF cop = 'in' THEN RETURN EXISTS (SELECT 1 FROM jsonb_array_elements(val) e WHERE e = fact);
  ELSIF cop = 'not_in' THEN RETURN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(val) e WHERE e = fact);
  END IF;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.eval_policy_node(jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.eval_policy_node(jsonb, jsonb) TO authenticated, service_role;

-- The single tier interpreter used everywhere
CREATE OR REPLACE FUNCTION public.evaluate_tier_policy(policy jsonb, facts jsonb)
RETURNS public.tier_label
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  rule jsonb;
BEGIN
  IF policy IS NULL THEN RETURN 'T5'::public.tier_label; END IF;
  FOR rule IN SELECT * FROM jsonb_array_elements(policy->'rules') LOOP
    IF public.eval_policy_node(rule->'when', facts) THEN
      RETURN (rule->>'tier')::public.tier_label;
    END IF;
  END LOOP;
  RETURN COALESCE((policy->>'default_tier')::public.tier_label, 'T5'::public.tier_label);
END;
$$;

REVOKE ALL ON FUNCTION public.evaluate_tier_policy(jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluate_tier_policy(jsonb, jsonb) TO authenticated, service_role;

-- Typed convenience overload building the facts object from columns
CREATE OR REPLACE FUNCTION public.evaluate_tier_policy(
  policy jsonb,
  is_official_domain boolean,
  is_primary_document boolean,
  traceability_level public.traceability_level,
  institution_class public.institution_class
)
RETURNS public.tier_label
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT public.evaluate_tier_policy(policy, jsonb_build_object(
    'is_official_domain', is_official_domain,
    'is_primary_document', is_primary_document,
    'traceability_level', traceability_level::text,
    'institution_class', institution_class::text
  ));
$$;

REVOKE ALL ON FUNCTION public.evaluate_tier_policy(jsonb, boolean, boolean, public.traceability_level, public.institution_class) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluate_tier_policy(jsonb, boolean, boolean, public.traceability_level, public.institution_class) TO authenticated, service_role;

-- Read API RPC: server-side only (service_role), keyset pagination
CREATE OR REPLACE FUNCTION public.api_list_items(
  p_profile_id uuid,
  p_updated_since timestamptz DEFAULT NULL,
  p_cursor_updated_at timestamptz DEFAULT NULL,
  p_cursor_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  id uuid,
  source_url text,
  jurisdiction_hint text,
  category text,
  payload jsonb,
  tier_label public.tier_label,
  policy_version integer,
  collected_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_policy jsonb;
  v_exposure jsonb;
  v_version integer;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
BEGIN
  SELECT tp.policy, tp.exposure, tp.version
    INTO v_policy, v_exposure, v_version
  FROM public.research_profile_tier_policies tp
  JOIN public.research_profiles rp ON rp.id = tp.profile_id AND rp.is_active
  WHERE tp.profile_id = p_profile_id AND tp.is_active
  LIMIT 1;

  IF v_policy IS NULL THEN
    RAISE EXCEPTION 'no active tier policy for profile';
  END IF;

  RETURN QUERY
  WITH scored AS (
    SELECT ni.id,
           ni.source_url,
           ni.jurisdiction_hint,
           ni.category,
           ni.payload,
           public.evaluate_tier_policy(v_policy, ni.is_official_domain, ni.is_primary_document, ni.traceability_level, ni.institution_class) AS tier,
           ni.collected_at,
           ni.updated_at
    FROM public.normalized_items ni
    WHERE (p_updated_since IS NULL OR ni.updated_at > p_updated_since)
      AND (
        p_cursor_updated_at IS NULL
        OR (ni.updated_at, ni.id) > (p_cursor_updated_at, COALESCE(p_cursor_id, '00000000-0000-0000-0000-000000000000'::uuid))
      )
  )
  SELECT s.id, s.source_url, s.jurisdiction_hint, s.category, s.payload,
         s.tier, v_version, s.collected_at, s.updated_at
  FROM scored s
  WHERE (
      v_exposure->'visible_tiers' @> to_jsonb(s.tier::text)
      OR (
        v_exposure->'hidden_tiers_require_promotion' @> to_jsonb(s.tier::text)
        AND EXISTS (
          SELECT 1 FROM public.normalized_item_profile_exposure e
          WHERE e.normalized_item_id = s.id AND e.profile_id = p_profile_id AND e.promoted
        )
      )
    )
  ORDER BY s.updated_at ASC, s.id ASC
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.api_list_items(uuid, timestamptz, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.api_list_items(uuid, timestamptz, timestamptz, uuid, integer) TO service_role;

-- Profile-agnostic staff view
CREATE OR REPLACE VIEW public.staff_item_tier_matrix
WITH (security_invoker = true) AS
SELECT ni.id AS normalized_item_id,
       ni.source_id,
       ni.source_url,
       ni.jurisdiction_hint,
       ni.category,
       ni.is_official_domain,
       ni.is_primary_document,
       ni.traceability_level,
       ni.institution_class,
       ni.collected_at,
       ni.updated_at,
       rp.id AS profile_id,
       rp.slug AS profile_slug,
       tp.version AS policy_version,
       public.evaluate_tier_policy(tp.policy, ni.is_official_domain, ni.is_primary_document, ni.traceability_level, ni.institution_class) AS resolved_tier,
       COALESCE(e.promoted, false) AS promoted_for_profile
FROM public.normalized_items ni
CROSS JOIN public.research_profiles rp
JOIN public.research_profile_tier_policies tp ON tp.profile_id = rp.id AND tp.is_active
LEFT JOIN public.normalized_item_profile_exposure e ON e.normalized_item_id = ni.id AND e.profile_id = rp.id
WHERE rp.is_active;

REVOKE ALL ON public.staff_item_tier_matrix FROM PUBLIC;
GRANT SELECT ON public.staff_item_tier_matrix TO authenticated, service_role;