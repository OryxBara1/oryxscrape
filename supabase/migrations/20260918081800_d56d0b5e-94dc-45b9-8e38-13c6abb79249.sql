-- 1. staff role model
create type public.staff_role as enum ('owner', 'staff');

create table public.staff_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  email text,
  role public.staff_role not null default 'staff',
  is_active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select on public.staff_members to authenticated;
grant all on public.staff_members to service_role;

alter table public.staff_members enable row level security;

create or replace function public.is_staff(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff_members
    where user_id = _user_id and is_active
  );
$$;

create or replace function public.is_staff_owner(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff_members
    where user_id = _user_id and is_active and role = 'owner'
  );
$$;

revoke execute on function public.is_staff(uuid) from anon;
revoke execute on function public.is_staff_owner(uuid) from anon;

create policy "Staff can read the staff list"
  on public.staff_members for select to authenticated
  using (public.is_staff(auth.uid()));

create trigger staff_members_set_updated_at
  before update on public.staff_members
  for each row execute function public.set_updated_at();

insert into public.staff_members (user_id, email, role, note)
values ('029d635f-efb6-4777-8ef1-75dd5c0cdb81', 'rogerio@oryxbara.com', 'owner', 'Initial owner; seeded with the staff-role migration.');

-- 2. tighten the twelve flagged tables
drop policy "Staff can read audit events" on public.audit_events;
drop policy "Staff can insert audit events" on public.audit_events;
create policy "Staff can read audit events" on public.audit_events
  for select to authenticated using (public.is_staff(auth.uid()));
create policy "Staff can insert audit events" on public.audit_events
  for insert to authenticated with check (public.is_staff(auth.uid()));

drop policy "Staff can read collection jobs" on public.collection_jobs;
drop policy "Staff can insert collection jobs" on public.collection_jobs;
drop policy "Staff can update collection jobs" on public.collection_jobs;
create policy "Staff can read collection jobs" on public.collection_jobs
  for select to authenticated using (public.is_staff(auth.uid()));
create policy "Staff can insert collection jobs" on public.collection_jobs
  for insert to authenticated with check (public.is_staff(auth.uid()));
create policy "Staff can update collection jobs" on public.collection_jobs
  for update to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

drop policy "Staff can read consumer keys" on public.consumer_keys;
drop policy "Staff can insert consumer keys" on public.consumer_keys;
drop policy "Staff can update consumer keys" on public.consumer_keys;
create policy "Staff can read consumer keys" on public.consumer_keys
  for select to authenticated using (public.is_staff(auth.uid()));
create policy "Staff can insert consumer keys" on public.consumer_keys
  for insert to authenticated with check (public.is_staff(auth.uid()));
create policy "Staff can update consumer keys" on public.consumer_keys
  for update to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

drop policy "Staff can read exchange handoffs" on public.exchange_handoffs;
drop policy "Staff can insert exchange handoffs" on public.exchange_handoffs;
drop policy "Staff can update exchange handoffs" on public.exchange_handoffs;
create policy "Staff can read exchange handoffs" on public.exchange_handoffs
  for select to authenticated using (public.is_staff(auth.uid()));
create policy "Staff can insert exchange handoffs" on public.exchange_handoffs
  for insert to authenticated with check (public.is_staff(auth.uid()));
create policy "Staff can update exchange handoffs" on public.exchange_handoffs
  for update to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

drop policy "Staff can read exchange suppressions" on public.exchange_suppressions;
drop policy "Staff can insert exchange suppressions" on public.exchange_suppressions;
drop policy "Staff can update exchange suppressions" on public.exchange_suppressions;
create policy "Staff can read exchange suppressions" on public.exchange_suppressions
  for select to authenticated using (public.is_staff(auth.uid()));
create policy "Staff can insert exchange suppressions" on public.exchange_suppressions
  for insert to authenticated with check (public.is_staff(auth.uid()));
create policy "Staff can update exchange suppressions" on public.exchange_suppressions
  for update to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

drop policy "Staff can read profile exposure" on public.normalized_item_profile_exposure;
drop policy "Staff can insert profile exposure" on public.normalized_item_profile_exposure;
drop policy "Staff can update profile exposure" on public.normalized_item_profile_exposure;
create policy "Staff can read profile exposure" on public.normalized_item_profile_exposure
  for select to authenticated using (public.is_staff(auth.uid()));
create policy "Staff can insert profile exposure" on public.normalized_item_profile_exposure
  for insert to authenticated with check (public.is_staff(auth.uid()));
create policy "Staff can update profile exposure" on public.normalized_item_profile_exposure
  for update to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

drop policy "Staff can read normalized items" on public.normalized_items;
drop policy "Staff can insert normalized items" on public.normalized_items;
drop policy "Staff can update normalized items" on public.normalized_items;
create policy "Staff can read normalized items" on public.normalized_items
  for select to authenticated using (public.is_staff(auth.uid()));
create policy "Staff can insert normalized items" on public.normalized_items
  for insert to authenticated with check (public.is_staff(auth.uid()));
create policy "Staff can update normalized items" on public.normalized_items
  for update to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

drop policy "Staff can read raw items" on public.raw_items;
drop policy "Staff can insert raw items" on public.raw_items;
create policy "Staff can read raw items" on public.raw_items
  for select to authenticated using (public.is_staff(auth.uid()));
create policy "Staff can insert raw items" on public.raw_items
  for insert to authenticated with check (public.is_staff(auth.uid()));

drop policy "Staff can read tier policies" on public.research_profile_tier_policies;
drop policy "Staff can insert tier policies" on public.research_profile_tier_policies;
drop policy "Staff can toggle active tier policy version" on public.research_profile_tier_policies;
create policy "Staff can read tier policies" on public.research_profile_tier_policies
  for select to authenticated using (public.is_staff(auth.uid()));
create policy "Owners can insert tier policies" on public.research_profile_tier_policies
  for insert to authenticated with check (public.is_staff_owner(auth.uid()));
create policy "Owners can toggle active tier policy version" on public.research_profile_tier_policies
  for update to authenticated using (public.is_staff_owner(auth.uid())) with check (public.is_staff_owner(auth.uid()));

drop policy "Staff can read research profiles" on public.research_profiles;
drop policy "Staff can insert research profiles" on public.research_profiles;
drop policy "Staff can update research profiles" on public.research_profiles;
create policy "Staff can read research profiles" on public.research_profiles
  for select to authenticated using (public.is_staff(auth.uid()));
create policy "Owners can insert research profiles" on public.research_profiles
  for insert to authenticated with check (public.is_staff_owner(auth.uid()));
create policy "Owners can update research profiles" on public.research_profiles
  for update to authenticated using (public.is_staff_owner(auth.uid())) with check (public.is_staff_owner(auth.uid()));

drop policy "Staff can read search terms" on public.search_terms;
drop policy "Staff can insert search terms" on public.search_terms;
drop policy "Staff can update search terms" on public.search_terms;
create policy "Staff can read search terms" on public.search_terms
  for select to authenticated using (public.is_staff(auth.uid()));
create policy "Staff can insert search terms" on public.search_terms
  for insert to authenticated with check (public.is_staff(auth.uid()));
create policy "Staff can update search terms" on public.search_terms
  for update to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

drop policy "Staff can read sources" on public.sources;
drop policy "Staff can insert sources" on public.sources;
drop policy "Staff can update sources" on public.sources;
drop policy "Staff can delete sources" on public.sources;
create policy "Staff can read sources" on public.sources
  for select to authenticated using (public.is_staff(auth.uid()));
create policy "Staff can insert sources" on public.sources
  for insert to authenticated with check (public.is_staff(auth.uid()));
create policy "Staff can update sources" on public.sources
  for update to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));
create policy "Owners can delete sources" on public.sources
  for delete to authenticated using (public.is_staff_owner(auth.uid()));

-- 3. gate the staff-only reporting function
create or replace function public.get_staff_item_tier_matrix()
returns table(
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
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.is_staff(auth.uid()) then
    raise exception 'Not authorized: staff access required';
  end if;

  return query
  select
    ni.id,
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
    public.evaluate_tier_policy(
      tp.policy,
      ni.is_official_domain,
      ni.is_primary_document,
      ni.traceability_level,
      ni.institution_class
    ),
    coalesce(ex.promoted, false)
  from public.normalized_items ni
  cross join public.research_profiles rp
  join public.research_profile_tier_policies tp
    on tp.profile_id = rp.id and tp.is_active
  left join public.normalized_item_profile_exposure ex
    on ex.normalized_item_id = ni.id and ex.profile_id = rp.id
  where rp.is_active;
end;
$$;

revoke execute on function public.get_staff_item_tier_matrix() from anon;