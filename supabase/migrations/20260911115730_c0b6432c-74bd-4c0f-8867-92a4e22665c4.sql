CREATE TABLE public.sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  domain text NOT NULL,
  start_url text NOT NULL,
  collection_method public.collection_method NOT NULL DEFAULT 'apify',
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  tos_status text NOT NULL DEFAULT 'unknown',
  tos_url text,
  tos_checked_at timestamptz,
  robots_status text NOT NULL DEFAULT 'unknown',
  robots_checked_at timestamptz,
  is_official_domain boolean NOT NULL DEFAULT false,
  is_primary_document boolean NOT NULL DEFAULT false,
  traceability_level public.traceability_level NOT NULL DEFAULT 'untraceable',
  institution_class public.institution_class NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sources_domain_start_url_key UNIQUE (domain, start_url),
  CONSTRAINT sources_tos_status_check CHECK (tos_status IN ('unknown','allowed','restricted','prohibited')),
  CONSTRAINT sources_robots_status_check CHECK (robots_status IN ('unknown','allowed','disallowed','partial'))
);

CREATE INDEX sources_is_active_idx ON public.sources (is_active);
CREATE INDEX sources_domain_idx ON public.sources (domain);
CREATE INDEX sources_institution_class_idx ON public.sources (institution_class);

CREATE TRIGGER set_sources_updated_at
BEFORE UPDATE ON public.sources
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

REVOKE ALL ON public.sources FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sources TO authenticated;
GRANT ALL ON public.sources TO service_role;

ALTER TABLE public.sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read sources" ON public.sources
FOR SELECT TO authenticated USING (true);

CREATE POLICY "Staff can insert sources" ON public.sources
FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Staff can update sources" ON public.sources
FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Staff can delete sources" ON public.sources
FOR DELETE TO authenticated USING (true);