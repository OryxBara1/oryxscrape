revoke truncate on table
  public.audit_events,
  public.collection_jobs,
  public.consumer_keys,
  public.exchange_handoffs,
  public.exchange_suppressions,
  public.normalized_item_profile_exposure,
  public.normalized_items,
  public.raw_items,
  public.research_profile_tier_policies,
  public.research_profiles,
  public.search_terms,
  public.sources,
  public.staff_members
from public, anon, authenticated;