import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getDashboardMetrics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [activeSources, runningJobs, recentItems, lastAudit] = await Promise.all([
      supabase.from("sources").select("id", { count: "exact", head: true }).eq("is_active", true),
      supabase
        .from("collection_jobs")
        .select("id", { count: "exact", head: true })
        .eq("status", "running"),
      supabase
        .from("normalized_items")
        .select("id", { count: "exact", head: true })
        .gte("collected_at", since),
      supabase
        .from("audit_events")
        .select("id, check_type, result, run_at, target_table")
        .order("run_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const firstError =
      activeSources.error ?? runningJobs.error ?? recentItems.error ?? lastAudit.error;
    if (firstError) throw new Error(firstError.message);

    return {
      activeSources: activeSources.count ?? 0,
      runningJobs: runningJobs.count ?? 0,
      itemsLast7Days: recentItems.count ?? 0,
      lastAudit: lastAudit.data,
    };
  });
