import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

type CheckType = Database["public"]["Enums"]["audit_check_type"];

export const listAuditEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { checkType?: CheckType | null; result?: string | null }) => input)
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("audit_events")
      .select("id, check_type, target_table, target_id, profile_id, result, findings, run_at")
      .order("run_at", { ascending: false })
      .limit(200);

    if (data.checkType) query = query.eq("check_type", data.checkType);
    if (data.result) query = query.eq("result", data.result);

    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return rows;
  });
