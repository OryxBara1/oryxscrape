CREATE TABLE public.consumer_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_app text NOT NULL,
  profile_id uuid NOT NULL REFERENCES public.research_profiles(id) ON DELETE RESTRICT,
  key_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  revoked_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consumer_keys_app_not_blank CHECK (length(btrim(consumer_app)) > 0),
  CONSTRAINT consumer_keys_hash_not_blank CHECK (length(btrim(key_hash)) >= 32)
);

CREATE INDEX idx_consumer_keys_profile ON public.consumer_keys(profile_id);
CREATE INDEX idx_consumer_keys_active ON public.consumer_keys(is_active);

CREATE TRIGGER set_consumer_keys_updated_at
  BEFORE UPDATE ON public.consumer_keys
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

REVOKE ALL ON public.consumer_keys FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON public.consumer_keys TO authenticated;
GRANT ALL ON public.consumer_keys TO service_role;

ALTER TABLE public.consumer_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read consumer keys"
  ON public.consumer_keys FOR SELECT TO authenticated USING (true);
CREATE POLICY "Staff can insert consumer keys"
  ON public.consumer_keys FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Staff can update consumer keys"
  ON public.consumer_keys FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_type public.audit_check_type NOT NULL,
  target_table text,
  target_id uuid,
  profile_id uuid REFERENCES public.research_profiles(id) ON DELETE SET NULL,
  result text NOT NULL DEFAULT 'ok',
  findings jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_result_valid CHECK (result IN ('ok','warning','failed')),
  CONSTRAINT audit_events_findings_is_object CHECK (jsonb_typeof(findings) = 'object')
);

CREATE INDEX idx_audit_events_run_at ON public.audit_events(run_at DESC);
CREATE INDEX idx_audit_events_check_type ON public.audit_events(check_type);
CREATE INDEX idx_audit_events_target ON public.audit_events(target_table, target_id);

REVOKE ALL ON public.audit_events FROM PUBLIC;
GRANT SELECT, INSERT ON public.audit_events TO authenticated;
GRANT ALL ON public.audit_events TO service_role;

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read audit events"
  ON public.audit_events FOR SELECT TO authenticated USING (true);
CREATE POLICY "Staff can insert audit events"
  ON public.audit_events FOR INSERT TO authenticated WITH CHECK (true);