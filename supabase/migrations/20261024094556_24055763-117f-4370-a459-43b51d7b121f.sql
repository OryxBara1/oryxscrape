ALTER TABLE public.sources
  ADD COLUMN proxy_config jsonb NULL;

ALTER TABLE public.sources
  ADD CONSTRAINT sources_proxy_config_shape CHECK (
    proxy_config IS NULL OR (
      proxy_config->>'type' = 'webshare'
      AND proxy_config->>'country_code' ~ '^[A-Z]{2}$'
      AND NOT (proxy_config ? 'username')
      AND NOT (proxy_config ? 'password')
    )
  );