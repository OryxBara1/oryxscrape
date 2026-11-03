-- Phase 1B step 2: Storage policies for bucket document-originals only.
-- Reuses public.is_staff() (no-arg). Touches no other bucket and no existing policy.
create policy "document_originals_staff_select"
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'document-originals' and public.is_staff());