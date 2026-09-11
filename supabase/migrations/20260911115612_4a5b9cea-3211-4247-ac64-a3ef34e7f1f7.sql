CREATE TYPE public.collection_method AS ENUM ('apify', 'http', 'api', 'manual');

CREATE TYPE public.traceability_level AS ENUM ('direct_url', 'domain_indicated', 'third_party_hosted', 'untraceable');

CREATE TYPE public.institution_class AS ENUM ('government', 'intergovernmental', 'court', 'academic', 'professional_body', 'registered_media', 'commercial', 'unknown');

CREATE TYPE public.job_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

CREATE TYPE public.tier_label AS ENUM ('T1', 'T2', 'T3', 'T4', 'T5');

CREATE TYPE public.audit_check_type AS ENUM ('duplicate', 'consistency', 'tier_drift', 'tos_recheck', 'robots_recheck');

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO service_role;