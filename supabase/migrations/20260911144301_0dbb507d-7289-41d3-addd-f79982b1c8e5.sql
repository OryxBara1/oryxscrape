-- 1. enums
CREATE TYPE public.verification_status AS ENUM ('unreviewed', 'reviewed', 'rejected');
CREATE TYPE public.publication_status AS ENUM ('internal_only', 'eligible');
ALTER TYPE public.audit_check_type ADD VALUE IF NOT EXISTS 'review_status_change';

-- 2. normalized_items review/publication controls
ALTER TABLE public.normalized_items
  ADD COLUMN verification_status public.verification_status NOT NULL DEFAULT 'unreviewed',
  ADD COLUMN publication_status public.publication_status NOT NULL DEFAULT 'internal_only',
  ADD COLUMN reviewed_by uuid,
  ADD COLUMN reviewed_at timestamptz,
  ADD CONSTRAINT normalized_items_review_publication_ck CHECK (
    (publication_status <> 'eligible' OR verification_status = 'reviewed')
    AND (verification_status <> 'rejected' OR publication_status = 'internal_only')
  );

CREATE INDEX IF NOT EXISTS normalized_items_review_state_idx
  ON public.normalized_items (verification_status, publication_status);

-- 3. rejected -> only unreviewed + internal_only
CREATE OR REPLACE FUNCTION public.enforce_review_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.verification_status = 'rejected'
     AND NEW.verification_status IS DISTINCT FROM OLD.verification_status THEN
    IF NEW.verification_status <> 'unreviewed' OR NEW.publication_status <> 'internal_only' THEN
      RAISE EXCEPTION 'a rejected item can only be reopened as unreviewed + internal_only';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_review_transition() FROM PUBLIC;

CREATE TRIGGER normalized_items_review_transition
BEFORE UPDATE ON public.normalized_items
FOR EACH ROW EXECUTE FUNCTION public.enforce_review_transition();

-- 4. audit every status change
CREATE OR REPLACE FUNCTION public.audit_review_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status
     OR NEW.publication_status IS DISTINCT FROM OLD.publication_status THEN
    INSERT INTO public.audit_events (check_type, target_table, target_id, result, findings, run_at)
    VALUES (
      'review_status_change',
      'normalized_items',
      NEW.id,
      'ok',
      jsonb_build_object(
        'normalized_item_id', NEW.id,
        'actor_user_id', auth.uid(),
        'previous_verification_status', OLD.verification_status,
        'new_verification_status', NEW.verification_status,
        'previous_publication_status', OLD.publication_status,
        'new_publication_status', NEW.publication_status,
        'changed_at', now()
      ),
      now()
    );
  END IF;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.audit_review_status_change() FROM PUBLIC;

CREATE TRIGGER normalized_items_review_audit
AFTER UPDATE ON public.normalized_items
FOR EACH ROW EXECUTE FUNCTION public.audit_review_status_change();

-- 5. raw_items provenance (nullable, no backfill here)
ALTER TABLE public.raw_items
  ADD COLUMN canonical_url text,
  ADD COLUMN http_status integer,
  ADD COLUMN content_type text,
  ADD COLUMN language text,
  ADD COLUMN apify_actor_id text,
  ADD COLUMN apify_run_id text,
  ADD COLUMN collector_version text;

-- 6. staff view: profile-agnostic, now surfaces review state
DROP VIEW IF EXISTS public.staff_item_tier_matrix;
CREATE VIEW public.staff_item_tier_matrix
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
       ni.verification_status,
       ni.publication_status,
       ni.reviewed_at,
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
GRANT SELECT ON public.staff_item_tier_matrix TO authenticated;

-- 7. guarded public read: reviewed + eligible only
CREATE OR REPLACE FUNCTION public.api_list_items(p_profile_id uuid, p_updated_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cursor_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 100)
 RETURNS TABLE(id uuid, source_url text, jurisdiction_hint text, category text, payload jsonb, tier_label public.tier_label, policy_version integer, collected_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    WHERE ni.verification_status = 'reviewed'
      AND ni.publication_status = 'eligible'
      AND (p_updated_since IS NULL OR ni.updated_at > p_updated_since)
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
$function$;

REVOKE ALL ON FUNCTION public.api_list_items(uuid, timestamptz, timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_list_items(uuid, timestamptz, timestamptz, uuid, integer) TO service_role;