# Phase 1B — Document copies, extraction and quality (plan + SQL for review)

Status: plan revision only. Nothing is executed. Three separately approved steps:
1. Database structures (SQL in section 12).
2. Private bucket and its Storage policies.
3. Storage code and collector integration.
Each step is verified before the next. Out of scope: UI, Phase 1C, LDH, scheduling, the 4 old advisor warnings. OryxScrape stays independent. Exposed schemas: not verified, not changed.

## 0. Roadmap entries (to be written to roadmap.md when edits are allowed; plan mode only permits this file)

Phase 1A closing note:
- Authorization tested by simulating database role/identity, not real browser logins; real-login test deferred to the UI phase.
- No DELETE/TRUNCATE verified for anon, authenticated, service_role only — not for owner/admin roles.
- Dedup tests proved constraints/uniqueness of supplied keys; key construction, URL canonicalization and conflict handling in code remain untested.
- Exposed schemas NOT verified; schema exposure, grants and RLS are three separate layers.
Pending, separate: conservative URL canonicalization (before Phase 2); 4 old advisor warnings (own round).
Phase 1B tasks: steps 1–3 above; owner decisions below.

## 1. Owner decisions recorded

- Intended limit 50 MB per file, subject to validation in the real Workers environment (128 MB isolate memory shared by concurrent requests). Streaming is preferred. If not viable, the constraint and an alternative are presented BEFORE lowering the limit.
- New collections only. No backfill. Old text is never reconstructed or presented as an original file.

## 2. Reused structures

| Existing | Role in 1B |
|---|---|
| `raw_items` | The collection event. Never modified; linked from sightings by FK. |
| `sources`, `collection_jobs` | Where/when a file was fetched (FKs on sightings). |
| `discovery_candidates` (1A) | Optional origin lead of a document (FK). |
| `public.is_staff()`, `public.set_updated_at()` | RLS and timestamps, same as all tables. |
| Fallback chain direct → Parallel → Webshare → blocked | Unchanged. Download failure stays on the existing blocked path. |
| `audit_events` | Used only to log reconciliation decisions (existing check_type values, no enum change in step 1). |

No storage buckets exist today and no code stores files.

## 3. Proposed tables (seven) and why each exists

This is one workable design, not the only one. Alternatives are noted.

1. `legal_documents` — the document believed to exist. Needed because one document can have many copies, and `normalized_items` is a publication record, not a document entity.
2. `document_copies` — one row per distinct byte content (unique `file_sha256`). Separates the obtained file from the document and from the text. Alternative: store copies per document (no global dedup) — rejected, it stores identical bytes repeatedly.
3. `document_copy_links` — copy ↔ legal_document, many-to-many. Needed because global dedup means one file can belong to more than one document (e.g. a gazette issue containing two acts, or an unresolved duplicate document). Alternative: FK `document_id` on copies — rejected, it would force one document per hash and break links on dedup.
4. `document_copy_sightings` — each time a file (or a size-impeded file) was seen: raw_item, source, job, URL, method, file name/MIME as received. This is the link to `raw_items`. Source-origin classification attaches here (section 5). Alternative: put origin on the copy — rejected by owner rule 2.
5. `document_extractions` — one text extraction run per copy: tool, version, exact-text hash, optional normalized hash. Separates extraction from file.
6. `document_assessments` — append-only judgments with typed targets (section 5).
7. `legal_document_versions` — documentary version of the norm, created only by an identified human. Separates "the law changed" from "the bytes changed".

Cardinality:
```text
legal_documents 1─n document_copy_links n─1 document_copies
document_copies 1─n document_copy_sightings n─1 raw_items / sources / collection_jobs
document_copies 1─n document_extractions
assessments → exactly one of: copy | extraction | sighting
legal_document_versions n─1 legal_documents, optional ref to copy + extraction
```

## 4. Hashes

- Format `sha256:<64 lowercase hex>`, CHECK `^sha256:[0-9a-f]{64}$`.
- `file_sha256`: hash of the exact received bytes.
- `text_sha256_exact`: hash of the exact UTF-8 bytes the extractor returned. This is the text fingerprint.
- `text_sha256_normalized` (optional) + `normalization_version` (required when present). Normalization v1: `\r\n`→`\n`, strip trailing whitespace per line, trim end. Used only to spot near-identical extractions; never as the literal text fingerprint.
- Hash change never means a normative change and never creates a documentary version. No trigger, function or collector path writes `legal_document_versions`; service_role has no INSERT on it.

## 5. Assessments

Three separate dimensions, each with its own allowed targets:

| dimension | allowed target | values |
|---|---|---|
| `technical_quality` | copy or extraction | `clean`, `defective`, `truncated`, `unreadable`, `unknown` (the five agreed grades) |
| `source_origin` | sighting only | `official_primary`, `official_secondary`, `third_party`, `unknown` |
| `approval` | copy or extraction | `approved`, `rejected`, `needs_recheck` — human only |

- `reasons text[]` holds detail such as `partial_ocr`, `missing_pages`, `encoding_errors`, `scanned_image_only`, `page_count_mismatch`. Reasons never replace the grade.
- Origin per sighting: the same copy seen on an official site and on an aggregator gets one assessment per sighting; neither overwrites the other.
- Target integrity: three nullable FKs (`copy_id`, `extraction_id`, `sighting_id`) with CHECK "exactly one", and CHECK of dimension ↔ target kind. Referenced rows must exist (FKs).
- Supersede integrity: `supersedes_assessment_id` FK; a trigger rejects it unless the referenced row has the same target and same dimension.
- Precedence ("current state", in a view):
  - If any human row exists for target+dimension: current = latest human row. If a newer automatic row disagrees, `needs_review = true`; the human value stays.
  - Else: current = latest automatic row, marked `basis = automatic`.
  - Never simply "latest row".

## 6. Size limit and storage impediment

- Check `Content-Length` first; stream with a running byte count and abort past 50 MB.
- Above the limit: no object, no copy row (there is no full hash without reading all bytes). A sighting is recorded with `byte_outcome = 'not_stored_size_limit'` and `copy_id` NULL. Quality is not assessed (= unknown by absence; nothing was examined). It is NOT graded unreadable.
- Streaming hash: Web Crypto `digest` is one-shot; incremental SHA-256 needs a small pure-JS library (e.g. `@noble/hashes`), validated in step 3. Upload streaming from Workers to Storage also needs validation. If real measurements show 50 MB is not viable under concurrency, I report numbers and an alternative (e.g. per-run concurrency of 1 for large files) before any lower limit.

## 7. Storage

- Bucket `document-originals`, private, 50 MB limit (step 2).
- Path determined only by content: `sha256/<2 hex>/<64 hex>` — no extension. Original file name, informed MIME (header) and detected MIME (magic bytes) are stored as metadata (detected on copy; informed name/MIME per sighting since different sources may send different ones).
- Long extracted text (> 1 MB): `text/<2 hex>/<64 hex of exact text>` in the same bucket.
- Policies (step 2): staff SELECT via `public.is_staff()`; no INSERT/UPDATE/DELETE for anon/authenticated. Writes by server code only. Downloads via short signed URLs from a staff-checked server function.

## 8. Upload / database consistency and recovery

Flow per file:
1. Download stream → bytes + `file_sha256` + size.
2. Copy row with that hash and `storage_status='stored'` exists → insert sighting only. (Dedup avoids duplicate storage; the download needed to compute the hash still happens.)
3. Insert copy row `storage_status='pending'` (unique hash; on conflict reuse existing row).
4. Upload to content path, `upsert: false`.
   - Created → go to 5.
   - "Already exists" → NOT treated as success yet: download object metadata/bytes, verify size and SHA-256 match. Match → 5. Mismatch → `storage_status='conflict'`, nothing overwritten, staff reconciliation.
5. Verify (size + hash) → update copy to `storage_status='stored'`, `stored_at`.
6. Insert sighting, link, extraction.

States and recovery:
- Orphan object (object, no copy row): possible if crash between 4 and 3-commit ordering is broken; with step 3 before upload it shows as a `pending` row. A read-only reconciliation lists objects without rows and rows stuck `pending` > 1 h.
- Pending row, object present and verified → promote to `stored` (non-destructive, automatic allowed).
- Row `stored` but object missing → set `storage_status='missing'`; row never deleted; next sighting of same hash re-uploads and re-verifies.
- Object incomplete / unexpected content → `conflict`; never overwritten automatically.
- Concurrency: unique hash + `pending` row means two runs share one row; the second waits for verification instead of uploading twice. Objects are never auto-deleted; any deletion requires a separate staff confirmation and is logged in `audit_events`.

## 9. Required behaviours

- Download fails: no copy, no sighting; existing blocked record + alert.
- File complete, extraction truncated: copy `stored`; extraction `truncation_status='truncated'`; automatic assessment `technical_quality=truncated` on the extraction with reasons. Re-extraction adds a new row.
- Same copy from another source: no new object or copy; new sighting with its own URL/source and its own origin assessment.
- Manual re-check (staff): re-download. Same hash → new sighting. Different hash → new copy + link to same document; old copy kept. No version created.

## 10. What guarantees "human action"

service_role bypasses RLS and Storage policies. Therefore:
- (a) Authenticated human path: RLS requires `is_staff()`, `assessed_by/created_by = auth.uid()`, `basis='human'`. Database-guaranteed for that path.
- (b) Collector: has no code path to versions, and service_role is granted no INSERT on `legal_document_versions` and cannot insert `approval` rows (CHECK requires `basis='human'` with `assessed_by`). This prevents accidental automatic approval/versioning, but service_role could still forge a `human` row with an arbitrary `assessed_by` — not preventable at DB level without removing service_role access.
- (c) Server-code discipline and keeping the service key secret are what protect against (b)'s residual risk.

## 11. Guaranteed by DB vs application

- DB: hash formats, unique file hash, FK target integrity, one-target CHECK, dimension/target/value CHECKs, supersede same-target trigger, append-only triggers, approval human-only CHECK, staff RLS, grants.
- App: correct hashing and streaming, size abort, upload-then-verify order, MIME detection, extraction truncation detection, reconciliation, signed URL lifetime.

## 12. Step 1 SQL (complete, for review; not executed)

Order checked: helper functions → tables in FK order → trigger functions → triggers → indexes → revokes/grants → RLS → view.

```sql
-- Prerequisites (exist in live DB): public.is_staff(), public.set_updated_at(),
-- public.raw_items, public.sources, public.collection_jobs, public.discovery_candidates.

-- 1. legal_documents
create table public.legal_documents (
  id uuid primary key default gen_random_uuid(),
  title text,
  identifier text,
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  issuing_authority text,
  language text,
  doc_type text,
  discovery_candidate_id uuid references public.discovery_candidates(id),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. document_copies
create table public.document_copies (
  id uuid primary key default gen_random_uuid(),
  file_sha256 text not null unique check (file_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  detected_mime_type text,
  storage_bucket text not null default 'document-originals' check (storage_bucket = 'document-originals'),
  storage_path text not null unique,
  storage_status text not null default 'pending'
    check (storage_status in ('pending','stored','missing','conflict')),
  stored_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_copies_path_matches_hash
    check (storage_path = 'sha256/' || substr(file_sha256, 8, 2) || '/' || substr(file_sha256, 8)),
  constraint document_copies_stored_at
    check ((storage_status = 'stored') = (stored_at is not null) or storage_status in ('missing','conflict'))
);

-- 3. document_copy_links (copy <-> document, many-to-many)
create table public.document_copy_links (
  id uuid primary key default gen_random_uuid(),
  copy_id uuid not null references public.document_copies(id),
  document_id uuid not null references public.legal_documents(id),
  linked_by uuid,
  link_basis text not null check (link_basis in ('collector','human')),
  note text,
  created_at timestamptz not null default now(),
  unique (copy_id, document_id)
);

-- 4. document_copy_sightings
create table public.document_copy_sightings (
  id uuid primary key default gen_random_uuid(),
  copy_id uuid references public.document_copies(id),
  document_id uuid references public.legal_documents(id),
  raw_item_id uuid references public.raw_items(id),
  source_id uuid references public.sources(id),
  collection_job_id uuid references public.collection_jobs(id),
  fetched_url text not null check (fetched_url ~ '^https?://'),
  fetch_method text not null check (fetch_method in ('http','parallel_extract','webshare','apify','manual','api')),
  received_filename text,
  informed_mime_type text,
  declared_size_bytes bigint,
  byte_outcome text not null check (byte_outcome in ('stored','deduplicated','not_stored_size_limit')),
  is_manual_recheck boolean not null default false,
  seen_by uuid,
  seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint sightings_copy_vs_outcome check (
    (byte_outcome = 'not_stored_size_limit' and copy_id is null)
    or (byte_outcome in ('stored','deduplicated') and copy_id is not null)
  )
);

-- 5. document_extractions
create table public.document_extractions (
  id uuid primary key default gen_random_uuid(),
  copy_id uuid not null references public.document_copies(id),
  extractor_tool text not null,
  extractor_version text not null,
  text_sha256_exact text not null check (text_sha256_exact ~ '^sha256:[0-9a-f]{64}$'),
  text_sha256_normalized text check (text_sha256_normalized is null or text_sha256_normalized ~ '^sha256:[0-9a-f]{64}$'),
  normalization_version text,
  char_count integer not null check (char_count >= 0),
  page_count_detected integer check (page_count_detected is null or page_count_detected >= 0),
  truncation_status text not null default 'unknown' check (truncation_status in ('complete','truncated','unknown')),
  text_inline text,
  text_storage_path text,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint extractions_normalized_needs_version
    check ((text_sha256_normalized is null) = (normalization_version is null)),
  constraint extractions_text_location check (
    (text_inline is not null and text_storage_path is null and octet_length(text_inline) <= 1048576)
    or (text_inline is null and text_storage_path is not null)
  ),
  constraint extractions_text_path_matches_hash check (
    text_storage_path is null
    or text_storage_path = 'text/' || substr(text_sha256_exact, 8, 2) || '/' || substr(text_sha256_exact, 8)
  ),
  unique (copy_id, extractor_tool, extractor_version, text_sha256_exact),
  constraint document_extractions_id_copy_key unique (id, copy_id)
);

-- 6. document_assessments
create table public.document_assessments (
  id uuid primary key default gen_random_uuid(),
  copy_id uuid references public.document_copies(id),
  extraction_id uuid references public.document_extractions(id),
  sighting_id uuid references public.document_copy_sightings(id),
  dimension text not null check (dimension in ('technical_quality','source_origin','approval')),
  value text not null,
  reasons text[] not null default '{}',
  basis text not null check (basis in ('automatic','human')),
  tool text,
  tool_version text,
  assessed_by uuid,
  supersedes_assessment_id uuid references public.document_assessments(id),
  note text,
  created_at timestamptz not null default now(),
  constraint assessments_exactly_one_target
    check (num_nonnulls(copy_id, extraction_id, sighting_id) = 1),
  constraint assessments_dimension_target check (
    (dimension = 'source_origin' and sighting_id is not null)
    or (dimension in ('technical_quality','approval') and sighting_id is null)
  ),
  constraint assessments_value check (
    (dimension = 'technical_quality' and value in ('clean','defective','truncated','unreadable','unknown'))
    or (dimension = 'source_origin' and value in ('official_primary','official_secondary','third_party','unknown'))
    or (dimension = 'approval' and value in ('approved','rejected','needs_recheck'))
  ),
  constraint assessments_reasons check (
    reasons <@ array['partial_ocr','missing_pages','encoding_errors','scanned_image_only',
                     'page_count_mismatch','corrupt_file','password_protected','other']::text[]
  ),
  constraint assessments_basis_identity check (
    (basis = 'human' and assessed_by is not null)
    or (basis = 'automatic' and assessed_by is null and tool is not null and tool_version is not null)
  ),
  constraint assessments_approval_human_only check (dimension <> 'approval' or basis = 'human')
);

-- 7. legal_document_versions
create table public.legal_document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.legal_documents(id),
  version_label text not null,
  valid_from date,
  valid_to date,
  supporting_copy_id uuid not null references public.document_copies(id),
  supporting_extraction_id uuid,
  created_by uuid not null,
  note text,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_from is null or valid_to >= valid_from),
  unique (document_id, version_label),
  -- extraction, when given, must belong to the supporting copy
  constraint versions_extraction_of_copy
    foreign key (supporting_extraction_id, supporting_copy_id)
    references public.document_extractions (id, copy_id),
  -- supporting copy must be linked to the versioned document
  constraint versions_copy_linked_to_document
    foreign key (supporting_copy_id, document_id)
    references public.document_copy_links (copy_id, document_id)
);

-- Trigger functions
create or replace function public.document_append_only()
returns trigger language plpgsql set search_path to '' as $$
begin
  raise exception '% is append-only', tg_table_name;
end; $$;

create or replace function public.document_copies_guard()
returns trigger language plpgsql set search_path to '' as $$
begin
  if new.file_sha256 is distinct from old.file_sha256
     or new.size_bytes is distinct from old.size_bytes
     or new.storage_bucket is distinct from old.storage_bucket
     or new.storage_path is distinct from old.storage_path
     or new.created_at is distinct from old.created_at then
    raise exception 'document_copies: identity fields are immutable';
  end if;
  return new;
end; $$;

create or replace function public.document_assessments_supersede_guard()
returns trigger language plpgsql set search_path to '' as $$
declare r public.document_assessments%rowtype;
begin
  if new.supersedes_assessment_id is null then return new; end if;
  select * into r from public.document_assessments where id = new.supersedes_assessment_id;
  if not found then raise exception 'superseded assessment does not exist'; end if;
  if r.dimension is distinct from new.dimension
     or r.copy_id is distinct from new.copy_id
     or r.extraction_id is distinct from new.extraction_id
     or r.sighting_id is distinct from new.sighting_id then
    raise exception 'supersede must reference the same target and dimension';
  end if;
  return new;
end; $$;

create or replace function public.legal_documents_guard()
returns trigger language plpgsql set search_path to '' as $$
begin
  if new.id is distinct from old.id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'legal_documents: id, created_by and created_at are immutable';
  end if;
  return new;
end; $$;

-- Triggers
create trigger set_legal_documents_updated_at before update on public.legal_documents
  for each row execute function public.set_updated_at();
create trigger legal_documents_guard before update on public.legal_documents
  for each row execute function public.legal_documents_guard();
create trigger set_document_copies_updated_at before update on public.document_copies
  for each row execute function public.set_updated_at();
create trigger document_copies_guard before update on public.document_copies
  for each row execute function public.document_copies_guard();
create trigger document_copy_links_append_only before update or delete on public.document_copy_links
  for each row execute function public.document_append_only();
create trigger document_copy_sightings_append_only before update or delete on public.document_copy_sightings
  for each row execute function public.document_append_only();
create trigger document_extractions_append_only before update or delete on public.document_extractions
  for each row execute function public.document_append_only();
create trigger document_assessments_append_only before update or delete on public.document_assessments
  for each row execute function public.document_append_only();
create trigger document_assessments_supersede_guard before insert on public.document_assessments
  for each row execute function public.document_assessments_supersede_guard();
create trigger legal_document_versions_append_only before update or delete on public.legal_document_versions
  for each row execute function public.document_append_only();

-- Indexes
create index on public.document_copy_links (document_id);
create index on public.document_copy_sightings (copy_id);
create index on public.document_copy_sightings (raw_item_id);
create index on public.document_copy_sightings (source_id);
create index on public.document_extractions (copy_id);
create index on public.document_assessments (copy_id, dimension, created_at);
create index on public.document_assessments (extraction_id, dimension, created_at);
create index on public.document_assessments (sighting_id, dimension, created_at);
create index on public.legal_document_versions (document_id);
create index on public.document_copies (storage_status) where storage_status <> 'stored';

-- Privileges: explicit revoke, then explicit grants
revoke all on public.legal_documents, public.document_copies, public.document_copy_links,
  public.document_copy_sightings, public.document_extractions, public.document_assessments,
  public.legal_document_versions from public, anon, authenticated, service_role;

grant select on public.legal_documents, public.document_copies, public.document_copy_links,
  public.document_copy_sightings, public.document_extractions, public.document_assessments,
  public.legal_document_versions to authenticated;
grant insert, update on public.legal_documents to authenticated;
grant insert on public.document_copy_links, public.document_assessments,
  public.legal_document_versions to authenticated;

grant select on public.legal_documents, public.document_copies, public.document_copy_links,
  public.document_copy_sightings, public.document_extractions, public.document_assessments,
  public.legal_document_versions to service_role;
grant insert, update on public.legal_documents, public.document_copies to service_role;
grant insert on public.document_copy_links, public.document_copy_sightings,
  public.document_extractions, public.document_assessments to service_role;
-- service_role: no INSERT on legal_document_versions; no DELETE/TRUNCATE anywhere.

revoke execute on function public.document_append_only(), public.document_copies_guard(),
  public.document_assessments_supersede_guard(), public.legal_documents_guard()
  from public, anon, authenticated;

-- RLS
alter table public.legal_documents enable row level security;
alter table public.document_copies enable row level security;
alter table public.document_copy_links enable row level security;
alter table public.document_copy_sightings enable row level security;
alter table public.document_extractions enable row level security;
alter table public.document_assessments enable row level security;
alter table public.legal_document_versions enable row level security;

create policy "staff read legal_documents" on public.legal_documents for select to authenticated using (public.is_staff());
create policy "staff insert legal_documents" on public.legal_documents for insert to authenticated
  with check (public.is_staff() and created_by = auth.uid());
create policy "staff update legal_documents" on public.legal_documents for update to authenticated
  using (public.is_staff()) with check (public.is_staff());

create policy "staff read document_copies" on public.document_copies for select to authenticated using (public.is_staff());

create policy "staff read document_copy_links" on public.document_copy_links for select to authenticated using (public.is_staff());
create policy "staff insert document_copy_links" on public.document_copy_links for insert to authenticated
  with check (public.is_staff() and link_basis = 'human' and linked_by = auth.uid());

create policy "staff read document_copy_sightings" on public.document_copy_sightings for select to authenticated using (public.is_staff());

create policy "staff read document_extractions" on public.document_extractions for select to authenticated using (public.is_staff());

create policy "staff read document_assessments" on public.document_assessments for select to authenticated using (public.is_staff());
create policy "staff insert human assessments" on public.document_assessments for insert to authenticated
  with check (public.is_staff() and basis = 'human' and assessed_by = auth.uid());

create policy "staff read legal_document_versions" on public.legal_document_versions for select to authenticated using (public.is_staff());
create policy "staff insert legal_document_versions" on public.legal_document_versions for insert to authenticated
  with check (public.is_staff() and created_by = auth.uid());

-- Current-state view with human precedence (security_invoker: caller's RLS applies)
create view public.document_assessment_current with (security_invoker = true) as
with t as (
  select a.*, coalesce(a.copy_id, a.extraction_id, a.sighting_id) as target_id,
         case when a.copy_id is not null then 'copy'
              when a.extraction_id is not null then 'extraction' else 'sighting' end as target_kind
  from public.document_assessments a
),
h as (select distinct on (target_kind, target_id, dimension) * from t where basis = 'human'
      order by target_kind, target_id, dimension, created_at desc, id desc),
au as (select distinct on (target_kind, target_id, dimension) * from t where basis = 'automatic'
       order by target_kind, target_id, dimension, created_at desc, id desc)
select coalesce(h.target_kind, au.target_kind) as target_kind,
       coalesce(h.target_id, au.target_id) as target_id,
       coalesce(h.dimension, au.dimension) as dimension,
       coalesce(h.value, au.value) as current_value,
       case when h.id is not null then 'human' else 'automatic' end as current_basis,
       coalesce(h.id, au.id) as current_assessment_id,
       au.value as latest_automatic_value,
       coalesce(h.id is not null and au.id is not null and au.created_at > h.created_at
                and au.value <> h.value, false) as needs_review
from h full join au
  on h.target_kind = au.target_kind and h.target_id = au.target_id and h.dimension = au.dimension;

revoke all on public.document_assessment_current from public, anon, authenticated, service_role;
grant select on public.document_assessment_current to authenticated, service_role;
```

Self-review done: every referenced table/function exists or is created earlier; CHECKs contain no subqueries; trigger functions precede triggers; the self-FK on assessments is valid in CREATE TABLE; the view is created after its table.

## 13. Verification per step

Step 1 (rolled-back test battery, like 1A): grants per role; RLS with simulated staff/non-staff/anon; append-only rejections; copies identity guard; exactly-one-target and dimension/value CHECKs; approval by automatic rejected; supersede across targets rejected; same hash duplicate rejected; size-limit sighting without copy accepted; view precedence (human beats newer automatic, `needs_review` true); service_role cannot insert versions; 13 old + 4 Phase 1A tables privileges unchanged; advisors before/after, new vs the 4 old.

Added for the three adjustments:
- Version with no supporting copy and no extraction → rejected (NOT NULL on supporting_copy_id).
- Version with extraction only (copy NULL) → rejected.
- Version with an extraction that belongs to a different copy → rejected (composite FK).
- Version whose copy is not linked to the document in `document_copy_links` → rejected (composite FK).
- Version with linked copy, with and without a matching extraction → accepted (as staff).
- `needs_review` is `false`, never NULL, for a human-only target and for an automatic-only target; `true` only for human + newer divergent automatic.
- Same target_id value under two target kinds is not merged in the view (kind is part of the key).
- `legal_documents`: update of `created_by` rejected; update of `created_at` rejected; update of `title` accepted — each tested as staff (authenticated) and as service_role.

## 14. Differences from the previous step 1 SQL (only these)

1. `document_extractions`: added `unique (id, copy_id)` as `document_extractions_id_copy_key` (target for a composite FK; `id` is already unique, so no behaviour change).
2. `legal_document_versions`:
   - `supporting_copy_id` is now NOT NULL (evidence required; an extraction alone is not enough because its copy must be validated).
   - Composite FK `(supporting_extraction_id, supporting_copy_id)` → `document_extractions(id, copy_id)`: when an extraction is given it must belong to the supporting copy (MATCH SIMPLE: skipped when extraction is NULL).
   - Composite FK `(supporting_copy_id, document_id)` → `document_copy_links(copy_id, document_id)`: the copy must be linked to the versioned document. Links are append-only, so the reference cannot later disappear.
   - Implementation is FK-only (no trigger), so it applies to every role and cannot be bypassed by service_role either. The DB only blocks contradictory references; it never decides whether the norm changed. Table stays append-only; service_role still has no INSERT.
3. New trigger function `public.legal_documents_guard()` + trigger `legal_documents_guard` (BEFORE UPDATE): rejects changes to `id`, `created_by`, `created_at`; title, identifier, country_code, issuing_authority, language, doc_type, discovery_candidate_id stay editable. Triggers fire for service_role too. EXECUTE revoked from public/anon/authenticated like the other trigger functions.
4. View `document_assessment_current`: `target_kind` added to both DISTINCT ON keys, their ORDER BY, and the full-join condition; `needs_review` wrapped in `coalesce(..., false)`.

No existing table is altered. Nothing else changed.
Step 2: bucket private; anon and non-staff cannot read/list/upload; staff signed URL works.
Step 3: vitest for hashing format, path from hash, verify-on-exists, size abort, dedup → sighting only, truncated extraction; real-environment memory/time measurement for 50 MB.

Stated limits carried from 1A: no real-browser login test; owner/admin roles not checked; service_role residual risk (section 10).
