# Phase 1B — Step 2: private bucket `document-originals` and its Storage policies

Status: PLAN ONLY. Nothing below is executed until step 2 is authorized separately.
Out of scope: step 3 (collector/downloads), UI, LDH, scheduling, the 4 old advisor warnings, exposed-schema settings.

## 0. Closing note for Phase 1B step 1 (to be written to roadmap.md when edits are allowed)

- Migration `20261102081642`; 74 checks passed; all 7 new tables empty after tests; privileges of the 17 previous tables preserved; no new advisor warnings (the 4 old ones unchanged).
- Authorization was tested by simulating role/identity in the database, not by real browser login.
- service_role can still insert an assessment falsely marked as human (it bypasses RLS and holds INSERT on `document_assessments`). We do NOT claim "human approval cannot be forged"; the protection on that path is server-code discipline plus keeping the service key secret.
- Coverage: some specific tests ran as owner (e.g. append-only triggers), but a full evaluation of all administrative/owner powers was NOT done.
- No bucket and no collection flow activated.

## 1. Bucket configuration

| Setting | Value |
|---|---|
| name / id | `document-originals` |
| public | `false` |
| file_size_limit | `52428800` bytes (50 MB, written to the tool as `"50MB"`; post-check must read back exactly 52428800) |
| allowed_mime_types | none (NULL) — see below |

Note: 50 MB is the intended limit; viability within the Workers 128 MB isolate (streaming, no full buffering) is validated in step 3, not here. If the project-wide limit is below 50 MB, the tool rejects it: STOP and report; do not lower silently.

### Why no MIME restriction
- Storage checks the Content-Type **informed** by the uploader, not the bytes. A restriction therefore does not prove what the file is; it only rejects uploads whose declared type is not on the list.
- Official sources often send wrong or generic types (`application/octet-stream`, `text/plain` for PDFs, `application/x-download`). A whitelist would reject legitimate originals, contradicting "never lose a document".
- Instead: the server always uploads with Content-Type `application/octet-stream` and signed URLs use the download option. These are delivery measures that reduce the chance of active content (HTML/SVG) rendering; they are NOT an absolute guarantee it is never opened. Metadata placement (existing tables, unchanged): the received filename and the MIME **informed** by the source go in `document_copy_sightings`; the MIME **detected** from magic bytes goes in `document_copies`. Type control lives in our metadata, not in the bucket.
- Alternative if the owner prefers a restriction: whitelist `application/octet-stream` only, which enforces the server rule above. Costs nothing functionally; I list it as an owner choice.

## 2. Policies on storage.objects (separate versioned migration)

Supabase already has RLS enabled on `storage.objects`. Policies are permissive and OR-combined, so any existing unscoped policy could still grant access to this bucket — the pre-flight (section 6) lists all existing `storage.objects` policies and STOPS if any of them is not bucket-scoped.

```sql
-- Phase 1B step 2: Storage policies for bucket document-originals only.
-- Prerequisite: bucket document-originals exists (created by the storage tool).
-- Reuses public.is_staff() (no-arg). Touches no other bucket and no existing policy.

begin;

-- Staff may read and list objects of this bucket (also required to create signed URLs).
create policy "document_originals_staff_select"
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'document-originals' and public.is_staff());

-- No INSERT / UPDATE / DELETE policies for anon or authenticated:
-- writes happen only on the server with the service role (bypasses RLS).
-- No object deletion path is granted to any browser role.

commit;
```

Deliberately absent: any policy `to anon`; any insert/update/delete policy; any change to `storage.buckets` (bucket rows are managed only by the storage tool).

## 3. Resulting permissions

| Caller | Read/download | List | Create signed URL | Upload / overwrite / delete |
|---|---|---|---|---|
| Visitor (anon) | no | no | no | no |
| Authenticated non-staff | no | no | no | no |
| Active staff | yes | yes | yes (needs SELECT) | no |
| Server (service_role) | yes | yes | yes | yes — bypasses RLS; guarded only by code discipline |

Signed URLs: issued only by a staff-authenticated server function, short expiry (proposed 300 s), with `download` set so the file is downloaded, not rendered. A signed URL is a bearer link: anyone holding it can read until expiry — stated, not hidden.

## 4. Server-only write path (contract for step 3; no code now)

- Module `src/lib/document-storage.server.ts` (server-only file), loaded only inside handlers; uses the generated admin client via dynamic import of `@/integrations/supabase/client.server`. The service key is read from `process.env` on the server and never sent to the browser or logged.
- Object path is content-addressed and extension-free: `sha256/<first 2 hex>/<full sha256>`.
- Upload with `upsert: false` and Content-Type `application/octet-stream`. An object that already exists at the path is accepted only after the size + hash verification below; existence alone proves nothing.
- Order: hash while streaming → `pending` `document_copies` row created or reused → upload → verification (size + hash of the stored object) → `stored`. Failures recorded explicitly (step 1B recovery rules: orphan object kept and reconciled, never auto-deleted).
- Conventions, not enforced by policy: 300 s signed-URL validity with download option, and issuing signed URLs only via the server function, are application conventions. The staff SELECT policy does not enforce them — staff with SELECT can request signed URLs directly from the Storage API.
- Browser never uploads directly. Staff downloads go through the signed-URL server function, which verifies `is_staff()` via the user's own session before signing.

## 5. Storage access tests and cleanup

Test objects live only under the prefix `__verification__/<run-uuid>/` (run-uuid generated per run and reported), never under `sha256/`.

1. Read-back of bucket config: public=false, file_size_limit=52428800, allowed_mime_types as decided.
2. Policy inventory: exactly one new policy, scoped to `bucket_id = 'document-originals'`; all pre-existing `storage.objects` policies identical to baseline.
3. Server upload (service_role) of two small test files to the prefix: succeeds; second upload of same path with `upsert:false` fails as "exists".
4. Over-limit upload (50 MB + 1 byte, test prefix): rejected.
5. Anon (publishable key, no session): list, download, sign, upload → all denied/empty.
6. Database simulation (rolled back): `set local role authenticated` + JWT claims for a non-staff uuid → 0 rows from `storage.objects` for this bucket; for a real active staff uuid → test rows visible; anon → 0 rows.
7. Real-login HTTP test (staff session and non-staff session): list, download, create signed URL, attempt upload/delete. If a real session cannot be minted (previous status `external_unmanaged`), this test is reported as NOT run; only the simulation stands.
8. Public URL of a test object returns not-found/denied (bucket private).
9. Other buckets: inventory before/after identical (currently none expected).

Cleanup (only test objects):
- List objects with prefix `__verification__/<run-uuid>/` via the Storage API as service_role; compare to the exact list of paths the test created; delete only those exact paths with `storage.remove([...])`. If the listing contains any path not created by this run, STOP and report — delete nothing.
- No SQL `DELETE` on `storage.objects`; no wildcard deletes.
- Post-check: prefix lists empty; total object count in the bucket = 0 (bucket is new).

## 6. Pre-flight, ordering and failure recovery

Pre-flight (read-only):
- `select * from storage.buckets where id = 'document-originals'`.
  - absent → proceed.
  - present with identical config → report, skip creation, continue to policies.
  - present with any difference (public, size limit, MIME list) → STOP and present the difference. Never overwrite.
- List all policies on `storage.objects` (baseline); STOP if any is unscoped to a bucket or already named `document_originals_*`.
- Confirm `public.is_staff()` exists; advisor baseline (4 old warnings).

Order (two separate operations):
1. Create bucket with the storage tool → read back config.
2. Apply the policies migration (one versioned, transactional migration).
3. Tests, cleanup, advisors after.

Failure between 1 and 2:
- Bucket exists, no policies → state is deny-all for anon/authenticated (only service_role can access). This is safe, not an exposure.
- Recovery: fix the migration and re-run it; do not delete or recreate the bucket. Verify by re-reading bucket config and policy inventory.
- If step 1 fails: do not run step 2; report the tool error (e.g. project size limit below 50 MB).
- If step 2 fails mid-way: transaction rolls back; policy inventory must equal baseline.

## 7. Owner decisions for step 2

1. MIME: no restriction (recommended) vs whitelist `application/octet-stream` only.
2. Signed URL expiry: 300 s proposed.
