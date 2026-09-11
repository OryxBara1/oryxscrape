DROP VIEW IF EXISTS public.staff_item_tier_matrix;
CREATE VIEW public.staff_item_tier_matrix AS
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