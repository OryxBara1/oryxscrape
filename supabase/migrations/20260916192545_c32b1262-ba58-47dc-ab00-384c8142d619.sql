ALTER TABLE public.sources
  ADD COLUMN IF NOT EXISTS schedule_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS schedule_notes text,
  ADD COLUMN IF NOT EXISTS last_scheduled_run_at timestamptz;

CREATE INDEX IF NOT EXISTS sources_schedule_enabled_idx
  ON public.sources (schedule_enabled)
  WHERE schedule_enabled;