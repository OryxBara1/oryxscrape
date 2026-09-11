CREATE TYPE public.exchange_handoff_state AS ENUM ('pending','feedback_received','accepted','rejected','error');
CREATE TYPE public.exchange_suppression_kind AS ENUM ('sha256','normalized_url','identifier_date','title_issuer_date','weak_filename');
CREATE TYPE public.search_term_lifecycle AS ENUM ('candidate','promising','validated','ambiguous','cooldown','disabled_auto','manual_only','deprecated');

CREATE TABLE public.exchange_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_item_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  normalized_item_id uuid NOT NULL REFERENCES public.normalized_items(id),
  artifact_kind text NOT NULL DEFAULT 'extracted_text_only',
  original_artifact_available boolean NOT NULL DEFAULT false,
  content_integrity_scope text NOT NULL DEFAULT 'normalized_extracted_text',
  artifact_sha256 text NOT NULL,
  artifact_filename text NOT NULL,
  artifact_mime_type text NOT NULL DEFAULT 'text/plain; charset=utf-8',
  artifact_size_bytes bigint NOT NULL,
  country_code text,
  language_code text,
  drive_folder_id text,
  drive_artifact_file_id text,
  drive_metadata_file_id text,
  state public.exchange_handoff_state NOT NULL DEFAULT 'pending',
  sent_at timestamptz,
  auramaris_decision text,
  auramaris_decision_at timestamptz,
  reason_code text,
  reason_detail text,
  drive_feedback_file_id text,
  drive_ack_file_id text,
  last_synced_at timestamptz,
  error_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX exchange_handoffs_active_item_uidx ON public.exchange_handoffs (normalized_item_id) WHERE state <> 'error';
CREATE UNIQUE INDEX exchange_handoffs_feedback_file_uidx ON public.exchange_handoffs (drive_feedback_file_id) WHERE drive_feedback_file_id IS NOT NULL;
CREATE INDEX exchange_handoffs_state_idx ON public.exchange_handoffs (state);

GRANT SELECT, INSERT, UPDATE ON public.exchange_handoffs TO authenticated;
GRANT ALL ON public.exchange_handoffs TO service_role;
ALTER TABLE public.exchange_handoffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can read exchange handoffs" ON public.exchange_handoffs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Staff can insert exchange handoffs" ON public.exchange_handoffs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Staff can update exchange handoffs" ON public.exchange_handoffs FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER set_exchange_handoffs_updated_at BEFORE UPDATE ON public.exchange_handoffs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.exchange_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_item_id uuid REFERENCES public.exchange_handoffs(exchange_item_id),
  rule_kind public.exchange_suppression_kind NOT NULL,
  match_value text NOT NULL,
  strength text NOT NULL DEFAULT 'review_signal',
  country_code text,
  concept_code text,
  reason_code text,
  reason_detail text,
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exchange_suppressions_strength_chk CHECK (
    (strength = 'hard_skip' AND rule_kind = 'sha256') OR strength = 'review_signal'
  )
);
CREATE UNIQUE INDEX exchange_suppressions_active_uidx ON public.exchange_suppressions (rule_kind, match_value) WHERE is_active;

GRANT SELECT, INSERT, UPDATE ON public.exchange_suppressions TO authenticated;
GRANT ALL ON public.exchange_suppressions TO service_role;
ALTER TABLE public.exchange_suppressions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can read exchange suppressions" ON public.exchange_suppressions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Staff can insert exchange suppressions" ON public.exchange_suppressions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Staff can update exchange suppressions" ON public.exchange_suppressions FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER set_exchange_suppressions_updated_at BEFORE UPDATE ON public.exchange_suppressions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.search_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_code text NOT NULL,
  concept_label text NOT NULL,
  country_code text,
  language_code text,
  term text NOT NULL,
  synonym_group text,
  target_domain text,
  attempt_count integer NOT NULL DEFAULT 0,
  useful_count integer NOT NULL DEFAULT 0,
  false_positive_count integer NOT NULL DEFAULT 0,
  credit_cost_estimate numeric,
  lifecycle_state public.search_term_lifecycle NOT NULL DEFAULT 'candidate',
  cooldown_until timestamptz,
  retry_after timestamptz,
  reactivation_reason text,
  last_run_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX search_terms_unique_idx ON public.search_terms (concept_code, term, coalesce(country_code,''));

GRANT SELECT, INSERT, UPDATE ON public.search_terms TO authenticated;
GRANT ALL ON public.search_terms TO service_role;
ALTER TABLE public.search_terms ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can read search terms" ON public.search_terms FOR SELECT TO authenticated USING (true);
CREATE POLICY "Staff can insert search terms" ON public.search_terms FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Staff can update search terms" ON public.search_terms FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER set_search_terms_updated_at BEFORE UPDATE ON public.search_terms FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.search_terms (concept_code, concept_label, country_code, language_code, term, target_domain, attempt_count, last_run_at)
SELECT DISTINCT ON (c.concept_code, c.term)
  c.concept_code, c.concept_label, 'FR', 'fr', c.term, 'legifrance.gouv.fr', 1, now()
FROM (
  SELECT
    coalesce(elem->>'concept_code', elem->>'conceptCode', elem->>'concept_label', elem->>'conceptLabel') AS concept_code,
    coalesce(elem->>'concept_label', elem->>'conceptLabel', elem->>'concept_code') AS concept_label,
    coalesce(elem->>'query', elem->>'term') AS term
  FROM public.collection_jobs j
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(j.run_params->'concepts') = 'array' THEN j.run_params->'concepts' ELSE '[]'::jsonb END
  ) AS elem
) c
WHERE c.concept_code IS NOT NULL AND c.term IS NOT NULL;