import { createFileRoute } from "@tanstack/react-router";

import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

const GIBRALTAR_LAWS_SOURCE_ID = "c5572bb7-a6ac-47df-9d00-edc4e382a296";

/**
 * Scheduled Gibraltar (Laws of Gibraltar) maritime collection.
 * Shared-secret authenticated, bounded per run. Jurisdiction is always GI.
 * Collection only — review stays human-driven.
 */
export const Route = createFileRoute("/api/public/cron/collect-gi-laws")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await authenticateCronRequest(request);
        if (denied) return denied;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runGibraltarCollection } = await import("@/lib/gibraltar-collect.server");

        try {
          const { data: source, error } = await supabaseAdmin
            .from("sources")
            .select("id,is_official_domain,is_primary_document,traceability_level,institution_class")
            .eq("id", GIBRALTAR_LAWS_SOURCE_ID)
            .single();
          if (error || !source) throw new Error(error?.message ?? "Gibraltar laws source missing");

          const r = await runGibraltarCollection({
            supabase: supabaseAdmin,
            source,
            profileId: null,
            limit: 15,
          });
          return Response.json(
            {
              ok: true,
              jobId: r.jobId,
              ingested: r.ingested,
              duplicates: r.duplicates,
              failed: r.failed,
              remaining: r.remaining,
            },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown failure";
          console.error("[cron/collect-gi-laws] failed", message);
          return Response.json(
            { ok: false, error: message },
            { status: 500, headers: { "Cache-Control": "no-store" } },
          );
        }
      },
    },
  },
});
