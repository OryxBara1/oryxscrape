ALTER TABLE public.research_profiles
  ADD COLUMN IF NOT EXISTS allowed_jurisdictions text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS allowed_tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS require_promotion boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS nipe_profile_promoted_idx ON public.normalized_item_profile_exposure (profile_id) WHERE promoted;