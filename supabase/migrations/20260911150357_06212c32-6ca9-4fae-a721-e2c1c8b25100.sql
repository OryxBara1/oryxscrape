CREATE OR REPLACE FUNCTION public.get_staff_item_tier_matrix()
RETURNS TABLE(
  normalized_item_id uuid,
  source_id uuid,
  source_url text,
  jurisdiction_hint text,
  category text,
  is_official_domain boolean,
  is_primary_document boolean,
  traceability_level public.traceability_level,
  institution_class public.institution_class,
  verification_status public.verification_status,
  publication_status public.publication_status,
  reviewed_at timestamptz,
  collected_at timestamptz,
  updated_at timestamptz,
  profile_id uuid,
  profile_slug text,
  policy_version integer,
  resolved_tier public.tier_label,
  promoted_for_profile boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT ni.id,
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
         rp.id,
         rp.slug,
         tp.version,
         public.evaluate_tier_policy(tp.policy, ni.is_official_domain, ni.is_primary_document, ni.traceability_level, ni.institution_class),
         COALESCE(e.promoted, false)
  FROM public.normalized_items ni
  CROSS JOIN public.research_profiles rp
  JOIN public.research_profile_tier_policies tp ON tp.profile_id = rp.id AND tp.is_active
  LEFT JOIN public.normalized_item_profile_exposure e ON e.normalized_item_id = ni.id AND e.profile_id = rp.id
  WHERE rp.is_active;
$$;

REVOKE ALL ON FUNCTION public.get_staff_item_tier_matrix() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_staff_item_tier_matrix() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.evaluate_tier_policy(jsonb, jsonb) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.evaluate_tier_policy(jsonb, boolean, boolean, public.traceability_level, public.institution_class) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.eval_policy_node(jsonb, jsonb) FROM authenticated;

DROP VIEW IF EXISTS public.staff_item_tier_matrix;