CREATE OR REPLACE FUNCTION public.schedule_eurlex_cron(p_secret text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron, pg_catalog
AS $$
DECLARE
  v_jobid bigint;
BEGIN
  PERFORM cron.unschedule(13);
  SELECT cron.schedule(
    'collect-eu-eurlex',
    '0 6 * * 1',
    format(
      $cmd$SELECT net.http_post(url := 'https://oryxscrape.lovable.app/api/public/cron/collect-eu-eurlex', headers := jsonb_build_object('Authorization', 'Bearer %s', 'Content-Type', 'application/json'), body := '{}'::jsonb);$cmd$,
      p_secret
    )
  ) INTO v_jobid;
  RETURN 'scheduled jobid=' || v_jobid;
END;
$$;
GRANT EXECUTE ON FUNCTION public.schedule_eurlex_cron(text) TO service_role;