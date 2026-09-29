CREATE OR REPLACE FUNCTION public.get_staff_item_tier_matrix()
 RETURNS TABLE(normalized_item_id uuid, source_id uuid, source_url text, jurisdiction_hint text, category text, is_official_domain boolean, is_primary_document boolean, traceability_level traceability_level, institution_class institution_class, verification_status verification_status, publication_status publication_status, reviewed_at timestamp with time zone, collected_at timestamp with time zone, updated_at timestamp with time zone, profile_id uuid, profile_slug text, policy_version integer, resolved_tier tier_label, promoted_for_profile boolean)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not public.is_staff() then
    raise exception 'Not authorized: staff access required';
  end if;
  return query
  select ni.id, ni.source_id, ni.source_url, ni.jurisdiction_hint, ni.category,
    ni.is_official_domain, ni.is_primary_document, ni.traceability_level, ni.institution_class,
    ni.verification_status, ni.publication_status, ni.reviewed_at, ni.collected_at, ni.updated_at,
    rp.id, rp.slug, tp.version,
    public.evaluate_tier_policy(tp.policy, ni.is_official_domain, ni.is_primary_document, ni.traceability_level, ni.institution_class),
    coalesce(ex.promoted, false)
  from public.normalized_items ni
  cross join public.research_profiles rp
  join public.research_profile_tier_policies tp on tp.profile_id = rp.id and tp.is_active
  left join public.normalized_item_profile_exposure ex on ex.normalized_item_id = ni.id and ex.profile_id = rp.id
  where rp.is_active;
end;
$function$;
REVOKE ALL ON FUNCTION public.get_staff_item_tier_matrix() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_staff_item_tier_matrix() TO authenticated, service_role;