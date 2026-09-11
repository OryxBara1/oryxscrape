CREATE TABLE public.collection_jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES public.sources(id) ON DELETE RESTRICT,
  profile_id uuid REFERENCES public.research_profiles(id) ON DELETE SET NULL,
  status public.job_status NOT NULL DEFAULT 'queued',
  started_at timestamptz,
  finished_at timestamptz,
  fetched_count integer NOT NULL DEFAULT 0 CHECK (fetched_count >= 0),
  new_count integer NOT NULL DEFAULT 0 CHECK (new_count >= 0),
  duplicate_count integer NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  error_text text,
  run_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  apify_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collection_jobs_source_id_idx ON public.collection_jobs (source_id);
CREATE INDEX collection_jobs_profile_id_idx ON public.collection_jobs (profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX collection_jobs_status_idx ON public.collection_jobs (status);
CREATE INDEX collection_jobs_created_at_idx ON public.collection_jobs (created_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.collection_jobs TO authenticated;
GRANT ALL ON public.collection_jobs TO service_role;

ALTER TABLE public.collection_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read collection jobs"
  ON public.collection_jobs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Staff can insert collection jobs"
  ON public.collection_jobs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Staff can update collection jobs"
  ON public.collection_jobs FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE TRIGGER set_collection_jobs_updated_at
  BEFORE UPDATE ON public.collection_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();