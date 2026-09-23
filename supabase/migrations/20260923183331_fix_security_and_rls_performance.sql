set local check_function_bodies = off;

alter default privileges for role "postgres" in schema "public" revoke all on sequences from "anon";

alter default privileges for role "postgres" in schema "public" revoke all on sequences from "authenticated";

alter default privileges for role "postgres" in schema "public" revoke all on sequences from "service_role";

alter default privileges for role "postgres" in schema "public" revoke all on FUNCTIONS from "anon";

alter default privileges for role "postgres" in schema "public" revoke all on FUNCTIONS from "authenticated";

alter default privileges for role "postgres" in schema "public" revoke all on FUNCTIONS from "service_role";

alter default privileges for role "postgres" in schema "public" revoke all on tables from "anon";

alter default privileges for role "postgres" in schema "public" revoke all on tables from "authenticated";

alter default privileges for role "postgres" in schema "public" revoke all on tables from "service_role";

revoke all on function "public"."audit_review_status_change"() from "service_role";

revoke all on function "public"."enforce_review_transition"() from "service_role";

revoke all on function "public"."enforce_tier_policy_append_only"() from "anon";

revoke all on function "public"."get_staff_item_tier_matrix"() from "authenticated";

revoke all on function "public"."is_valid_exposure_policy"(jsonb) from "anon";

revoke all on function "public"."is_valid_policy_node"(jsonb, integer) from "anon";

revoke all on function "public"."is_valid_tier_policy"(jsonb) from "anon";

revoke all on function "public"."set_updated_at"() from "anon";

drop policy "Staff can insert audit events" on "public"."audit_events";

drop policy "Staff can read audit events" on "public"."audit_events";

drop policy "Staff can insert collection jobs" on "public"."collection_jobs";

drop policy "Staff can read collection jobs" on "public"."collection_jobs";

drop policy "Staff can update collection jobs" on "public"."collection_jobs";

drop policy "Staff can insert consumer keys" on "public"."consumer_keys";

drop policy "Staff can read consumer keys" on "public"."consumer_keys";

drop policy "Staff can update consumer keys" on "public"."consumer_keys";

drop policy "Staff can insert exchange handoffs" on "public"."exchange_handoffs";

drop policy "Staff can read exchange handoffs" on "public"."exchange_handoffs";

drop policy "Staff can update exchange handoffs" on "public"."exchange_handoffs";

drop policy "Staff can insert exchange suppressions" on "public"."exchange_suppressions";

drop policy "Staff can read exchange suppressions" on "public"."exchange_suppressions";

drop policy "Staff can update exchange suppressions" on "public"."exchange_suppressions";

drop policy "Staff can insert profile exposure" on "public"."normalized_item_profile_exposure";

drop policy "Staff can read profile exposure" on "public"."normalized_item_profile_exposure";

drop policy "Staff can update profile exposure" on "public"."normalized_item_profile_exposure";

drop policy "Staff can insert normalized items" on "public"."normalized_items";

drop policy "Staff can read normalized items" on "public"."normalized_items";

drop policy "Staff can update normalized items" on "public"."normalized_items";

drop policy "Staff can insert raw items" on "public"."raw_items";

drop policy "Staff can read raw items" on "public"."raw_items";

drop policy "Owners can insert tier policies" on "public"."research_profile_tier_policies";

drop policy "Owners can toggle active tier policy version" on "public"."research_profile_tier_policies";

drop policy "Staff can read tier policies" on "public"."research_profile_tier_policies";

drop policy "Owners can insert research profiles" on "public"."research_profiles";

drop policy "Owners can update research profiles" on "public"."research_profiles";

drop policy "Staff can read research profiles" on "public"."research_profiles";

drop policy "Staff can insert search terms" on "public"."search_terms";

drop policy "Staff can read search terms" on "public"."search_terms";

drop policy "Staff can update search terms" on "public"."search_terms";

drop policy "Owners can delete sources" on "public"."sources";

drop policy "Staff can insert sources" on "public"."sources";

drop policy "Staff can read sources" on "public"."sources";

drop policy "Staff can update sources" on "public"."sources";

drop policy "Staff can read the staff list" on "public"."staff_members";

create extension "pg_net" schema "extensions";

create index idx_audit_events_profile_id on public.audit_events using btree (profile_id);

create index idx_exchange_suppressions_exchange_item_id on public.exchange_suppressions using btree (exchange_item_id);

create policy "Staff can insert audit events" on "public"."audit_events"
  for insert
  to PUBLIC
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Staff can read audit events" on "public"."audit_events"
  for select
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)));

create policy "Staff can insert collection jobs" on "public"."collection_jobs"
  for insert
  to PUBLIC
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Staff can read collection jobs" on "public"."collection_jobs"
  for select
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)));

create policy "Staff can update collection jobs" on "public"."collection_jobs"
  for update
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)))
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Staff can insert consumer keys" on "public"."consumer_keys"
  for insert
  to PUBLIC
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Staff can read consumer keys" on "public"."consumer_keys"
  for select
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)));

create policy "Staff can update consumer keys" on "public"."consumer_keys"
  for update
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)))
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Staff can insert exchange handoffs" on "public"."exchange_handoffs"
  for insert
  to PUBLIC
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Staff can read exchange handoffs" on "public"."exchange_handoffs"
  for select
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)));

create policy "Staff can update exchange handoffs" on "public"."exchange_handoffs"
  for update
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)))
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Staff can insert exchange suppressions" on "public"."exchange_suppressions"
  for insert
  to PUBLIC
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Staff can read exchange suppressions" on "public"."exchange_suppressions"
  for select
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)));

create policy "Staff can update exchange suppressions" on "public"."exchange_suppressions"
  for update
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)))
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Staff can insert profile exposure" on "public"."normalized_item_profile_exposure"
  for insert
  to PUBLIC
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Staff can read profile exposure" on "public"."normalized_item_profile_exposure"
  for select
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)));

create policy "Staff can update profile exposure" on "public"."normalized_item_profile_exposure"
  for update
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)))
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Staff can insert normalized items" on "public"."normalized_items"
  for insert
  to PUBLIC
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Staff can read normalized items" on "public"."normalized_items"
  for select
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)));

create policy "Staff can update normalized items" on "public"."normalized_items"
  for update
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)))
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Staff can insert raw items" on "public"."raw_items"
  for insert
  to PUBLIC
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Staff can read raw items" on "public"."raw_items"
  for select
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)));

create policy "Owners can insert tier policies" on "public"."research_profile_tier_policies"
  for insert
  to PUBLIC
  with check (public.is_staff_owner(( SELECT auth.uid() AS uid)));

create policy "Owners can toggle active tier policy version" on "public"."research_profile_tier_policies"
  for update
  to PUBLIC
  using (public.is_staff_owner(( select auth.uid() as uid)))
  with check (public.is_staff_owner(( SELECT auth.uid() AS uid)));

create policy "Staff can read tier policies" on "public"."research_profile_tier_policies"
  for select
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)));

create policy "Owners can insert research profiles" on "public"."research_profiles"
  for insert
  to PUBLIC
  with check (public.is_staff_owner(( SELECT auth.uid() AS uid)));

create policy "Owners can update research profiles" on "public"."research_profiles"
  for update
  to PUBLIC
  using (public.is_staff_owner(( select auth.uid() as uid)))
  with check (public.is_staff_owner(( SELECT auth.uid() AS uid)));

create policy "Staff can read research profiles" on "public"."research_profiles"
  for select
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)));

create policy "Staff can insert search terms" on "public"."search_terms"
  for insert
  to PUBLIC
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Staff can read search terms" on "public"."search_terms"
  for select
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)));

create policy "Staff can update search terms" on "public"."search_terms"
  for update
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)))
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Owners can delete sources" on "public"."sources"
  for delete
  to PUBLIC
  using (public.is_staff_owner(( select auth.uid() as uid)));

create policy "Staff can insert sources" on "public"."sources"
  for insert
  to PUBLIC
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Staff can read sources" on "public"."sources"
  for select
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)));

create policy "Staff can update sources" on "public"."sources"
  for update
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)))
  with check (public.is_staff(( SELECT auth.uid() AS uid)));

create policy "Staff can read the staff list" on "public"."staff_members"
  for select
  to PUBLIC
  using (public.is_staff(( select auth.uid() as uid)));

comment on extension "pg_net" is 'Async HTTP';

revoke all on table "public"."audit_events" from "authenticated";

grant insert, maintain, references, select, trigger, truncate on table "public"."audit_events" to "authenticated";

revoke all on table "public"."collection_jobs" from "authenticated";

grant insert, maintain, references, select, trigger, truncate, update on table "public"."collection_jobs" to "authenticated";

revoke all on table "public"."consumer_keys" from "authenticated";

grant insert, maintain, references, select, trigger, truncate, update on table "public"."consumer_keys" to "authenticated";

revoke all on table "public"."exchange_handoffs" from "anon";

grant maintain, references, trigger, truncate on table "public"."exchange_handoffs" to "anon";

revoke all on table "public"."exchange_handoffs" from "authenticated";

grant insert, maintain, references, select, trigger, truncate, update on table "public"."exchange_handoffs" to "authenticated";

revoke all on table "public"."exchange_suppressions" from "anon";

grant maintain, references, trigger, truncate on table "public"."exchange_suppressions" to "anon";

revoke all on table "public"."exchange_suppressions" from "authenticated";

grant insert, maintain, references, select, trigger, truncate, update on table "public"."exchange_suppressions" to "authenticated";

revoke all on table "public"."normalized_item_profile_exposure" from "authenticated";

grant insert, maintain, references, select, trigger, truncate, update on table "public"."normalized_item_profile_exposure" to "authenticated";

revoke all on table "public"."normalized_items" from "authenticated";

grant insert, maintain, references, select, trigger, truncate, update on table "public"."normalized_items" to "authenticated";

revoke all on table "public"."raw_items" from "authenticated";

grant insert, maintain, references, select, trigger, truncate on table "public"."raw_items" to "authenticated";

revoke all on table "public"."raw_items" from "service_role";

grant insert, maintain, references, select, trigger, truncate on table "public"."raw_items" to "service_role";

revoke all on table "public"."research_profile_tier_policies" from "authenticated";

grant insert, maintain, references, select, trigger, truncate, update on table "public"."research_profile_tier_policies" to "authenticated";

revoke all on table "public"."research_profile_tier_policies" from "service_role";

grant insert, maintain, references, select, trigger, truncate, update on table "public"."research_profile_tier_policies" to "service_role";

revoke all on table "public"."research_profiles" from "authenticated";

grant insert, maintain, references, select, trigger, truncate, update on table "public"."research_profiles" to "authenticated";

revoke all on table "public"."search_terms" from "anon";

grant maintain, references, trigger, truncate on table "public"."search_terms" to "anon";

revoke all on table "public"."search_terms" from "authenticated";

grant insert, maintain, references, select, trigger, truncate, update on table "public"."search_terms" to "authenticated";

revoke all on table "public"."staff_members" from "anon";

grant maintain, references, trigger, truncate on table "public"."staff_members" to "anon";

revoke all on table "public"."staff_members" from "authenticated";

grant maintain, references, select, trigger, truncate on table "public"."staff_members" to "authenticated";

alter default privileges for role "postgres" in schema "public" grant maintain, references, trigger, truncate on tables to "anon";

alter default privileges for role "postgres" in schema "public" grant maintain, references, trigger, truncate on tables to "authenticated";

alter default privileges for role "postgres" in schema "public" grant maintain, references, trigger, truncate on tables to "service_role";
