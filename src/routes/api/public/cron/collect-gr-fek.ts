import { createFileRoute } from "@tanstack/react-router";

import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

const FEK_SOURCE_ID = "7bc20b3f-0207-451e-b833-816f045cc435";

/**
 * Scheduled Greece (ΦΕΚ, et.gr open API) collection. Shared-secret authenticated.
 * Returns counts only. Collection only — review stays human-driven.
 */
export const Route = createFileRoute("/api/public/cron/collect-gr-fek")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await authenticateCronRequest(request);
        if (denied) return denied;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runFekCollection } = await import("@/lib/fek-collect.server");

        try {
          const { data: source, error } = await supabaseAdmin
            .from("sources")
            .select("id,is_official_domain,is_primary_document,traceability_level,institution_class")
            .eq("id", FEK_SOURCE_ID)
            .single();
          if (error || !source) throw new Error(error?.message ?? "FEK source missing");
          const r = await runFekCollection({ supabase: supabaseAdmin, source, profileId: null, limit: 4 });
          return Response.json(
            { ok: true, jobId: r.jobId, ingested: r.ingested, duplicates: r.duplicates, failed: r.failed },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown failure";
          console.error("[cron/collect-gr-fek] failed", message);
          return Response.json(
            { ok: false, error: message },
            { status: 500, headers: { "Cache-Control": "no-store" } },
          );
        }
      },
    },
  },
});
