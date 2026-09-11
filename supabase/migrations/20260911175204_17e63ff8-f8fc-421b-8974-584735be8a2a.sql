ALTER TABLE public.sources
  ADD COLUMN IF NOT EXISTS crawler_type text NOT NULL DEFAULT 'cheerio',
  ADD COLUMN IF NOT EXISTS include_url_globs text[];

ALTER TABLE public.sources
  DROP CONSTRAINT IF EXISTS sources_crawler_type_check;

ALTER TABLE public.sources
  ADD CONSTRAINT sources_crawler_type_check
  CHECK (crawler_type IN ('cheerio', 'playwright:firefox'));

UPDATE public.sources
SET crawler_type = 'playwright:firefox'
WHERE domain = 'narodne-novine.nn.hr';