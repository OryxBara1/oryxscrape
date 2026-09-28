DO $$
DECLARE
  v_auth text;
  v_base text := 'https://oryxscrape.lovable.app/api/public/cron/';
  r record;
BEGIN
  SELECT substring(command from 'Bearer [^''"]+') INTO v_auth FROM cron.job WHERE jobid = 21;
  IF v_auth IS NULL THEN RAISE EXCEPTION 'reference token not found'; END IF;

  FOR r IN SELECT * FROM (VALUES (11,'collect-fr-legifrance'),(17,'collect-it-normattiva'),(18,'collect-es-boe'),(19,'collect-hr-nn')) AS t(jobid, route) LOOP
    PERFORM cron.alter_job(
      job_id := r.jobid,
      command := format(
        'SELECT net.http_post(url := %L, headers := jsonb_build_object(%L, %L, %L, %L), body := %L::jsonb, timeout_milliseconds := 300000);',
        v_base || r.route, 'Authorization', v_auth, 'Content-Type', 'application/json', '{}')
    );
  END LOOP;

  PERFORM cron.unschedule(j) FROM unnest(ARRAY[12,14,15,16,20]) AS j WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobid = j);
END $$;