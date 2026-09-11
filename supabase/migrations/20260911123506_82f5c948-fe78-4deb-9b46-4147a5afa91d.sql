CREATE TABLE public.raw_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES public.collection_jobs(id) ON DELETE SET NULL,
  source_id uuid NOT NULL REFERENCES public.sources(id) ON DELETE RESTRICT,
  source_url text NOT NULL,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  collection_method public.collection_method NOT NULL DEFAULT 'apify'::public.collection_method,
  is_official_domain boolean NOT NULL,
  is_primary_document boolean NOT NULL,
  traceability_level public.traceability_level NOT NULL,
  institution_class public.institution_class NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT raw_items_content_hash_not_blank CHECK (length(btrim(content_hash)) > 0),
  CONSTRAINT raw_items_source_url_not_blank CHECK (length(btrim(source_url)) > 0),
  CONSTRAINT raw_items_source_content_hash_unique UNIQUE (source_id, content_hash)
);

CREATE INDEX idx_raw_items_source_id ON public.raw_items(source_id);
CREATE INDEX idx_raw_items_job_id ON public.raw_items(job_id);
CREATE INDEX idx_raw_items_collected_at ON public.raw_items(collected_at DESC);

REVOKE ALL ON public.raw_items FROM PUBLIC;
GRANT SELECT, INSERT ON public.raw_items TO authenticated;
GRANT SELECT, INSERT ON public.raw_items TO service_role;

ALTER TABLE public.raw_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read raw items"
  ON public.raw_items FOR SELECT TO authenticated USING (true);

CREATE POLICY "Staff can insert raw items"
  ON public.raw_items FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Service role can insert raw items"
  ON public.raw_items FOR INSERT TO service_role WITH CHECK (true);

CREATE POLICY "Service role can read raw items"
  ON public.raw_items FOR SELECT TO service_role USING (true);