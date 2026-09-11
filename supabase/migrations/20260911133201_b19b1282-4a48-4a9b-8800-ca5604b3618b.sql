INSERT INTO public.sources (
  name, domain, start_url, collection_method, is_active, notes,
  tos_status, tos_url, robots_status,
  is_official_domain, is_primary_document, traceability_level, institution_class
) VALUES (
  'BOE — Boletín Oficial del Estado',
  'boe.es',
  'https://www.boe.es/buscar/legislacion.php',
  'apify',
  true,
  'Phase 5 proof-of-concept source. Output is diffed against the AuraMaris BOE baseline.',
  'unknown',
  'https://www.boe.es/informacion/aviso_legal.php',
  'unknown',
  true,
  true,
  'direct_url',
  'government'
)
ON CONFLICT (domain, start_url) DO NOTHING;