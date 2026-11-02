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
