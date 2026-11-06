ALTER TABLE public.discovery_candidates
  DROP CONSTRAINT discovery_candidates_provider_source_check,
  ADD CONSTRAINT discovery_candidates_provider_source_check
    CHECK (provider_source ~ '^[A-Za-z0-9_.:/-]{1,100}$');

ALTER TABLE public.discovery_sightings
  DROP CONSTRAINT discovery_sightings_matched_key_check,
  ADD CONSTRAINT discovery_sightings_matched_key_check
    CHECK (matched_key = ANY (ARRAY['initial','provider','identifier','url']));