CREATE TABLE public.normalized_item_profile_exposure (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_item_id uuid NOT NULL REFERENCES public.normalized_items(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.research_profiles(id) ON DELETE RESTRICT,
  promoted boolean NOT NULL DEFAULT false,
  promoted_by uuid,
  promoted_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT normalized_item_profile_exposure_unique UNIQUE (normalized_item_id, profile_id)
);

CREATE INDEX idx_nipe_profile_promoted ON public.normalized_item_profile_exposure(profile_id, promoted);
CREATE INDEX idx_nipe_item ON public.normalized_item_profile_exposure(normalized_item_id);

CREATE TRIGGER set_nipe_updated_at
  BEFORE UPDATE ON public.normalized_item_profile_exposure
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

REVOKE ALL ON public.normalized_item_profile_exposure FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.normalized_item_profile_exposure TO authenticated;
GRANT ALL ON public.normalized_item_profile_exposure TO service_role;

ALTER TABLE public.normalized_item_profile_exposure ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read profile exposure"
  ON public.normalized_item_profile_exposure FOR SELECT TO authenticated USING (true);

CREATE POLICY "Staff can insert profile exposure"
  ON public.normalized_item_profile_exposure FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Staff can update profile exposure"
  ON public.normalized_item_profile_exposure FOR UPDATE TO authenticated USING (true) WITH CHECK (true);