insert into public.sources (name, domain, start_url, collection_method, is_active, crawler_type, tos_status, robots_status, is_official_domain, is_primary_document, traceability_level, institution_class, schedule_enabled, schedule_notes, notes)
select 'Normattiva — Italy', 'normattiva.it', 'https://www.normattiva.it/', 'api', true, 'cheerio', 'unknown', 'unknown', true, true, 'direct_url', 'government', true,
 'Weekly Wednesday 03:00 UTC via /api/public/cron/collect-it-normattiva',
 'Normattiva open data API (api.normattiva.it bff-opendata), GU publication-date bounded'
where not exists (select 1 from public.sources where domain = 'normattiva.it');