import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listCollectionJobs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("collection_jobs")
      .select(
        "id, status, started_at, finished_at, fetched_count, new_count, duplicate_count, failed_count, error_text, apify_run_id, created_at, source_id, profile_id, sources(name, domain), research_profiles(slug)",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return data;
  });
