CREATE TABLE public.normalized_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_item_id uuid NOT NULL UNIQUE REFERENCES public.raw_items(id) ON DELETE RESTRICT,
  source_id uuid NOT NULL REFERENCES public.sources(id) ON DELETE RESTRICT,
  source_url text NOT NULL,
  jurisdiction_hint text,
  category text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_official_domain boolean NOT NULL,
  is_primary_document boolean NOT NULL,
  traceability_level public.traceability_level NOT NULL,
  institution_class public.institution_class NOT NULL,
  collected_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT normalized_items_source_url_not_blank CHECK (length(btrim(source_url)) > 0),
  CONSTRAINT normalized_items_payload_is_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX idx_normalized_items_jurisdiction_hint ON public.normalized_items(jurisdiction_hint);
CREATE INDEX idx_normalized_items_category ON public.normalized_items(category);
CREATE INDEX idx_normalized_items_source_id ON public.normalized_items(source_id);
CREATE INDEX idx_normalized_items_updated_at ON public.normalized_items(updated_at DESC);
CREATE INDEX idx_normalized_items_sync ON public.normalized_items(updated_at, id);
CREATE INDEX idx_normalized_items_payload ON public.normalized_items USING gin (payload);

CREATE TRIGGER set_normalized_items_updated_at
  BEFORE UPDATE ON public.normalized_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

REVOKE ALL ON public.normalized_items FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.normalized_items TO authenticated;
GRANT ALL ON public.normalized_items TO service_role;

ALTER TABLE public.normalized_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read normalized items"
  ON public.normalized_items FOR SELECT TO authenticated USING (true);

CREATE POLICY "Staff can insert normalized items"
  ON public.normalized_items FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Staff can update normalized items"
  ON public.normalized_items FOR UPDATE TO authenticated USING (true) WITH CHECK (true);