import { createFileRoute } from "@tanstack/react-router";

import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

/**
 * Scheduled UK legislation collection (legislation.gov.uk Atom feed).
 * Shared-secret authenticated. Returns counts only — no document content,
 * no PII. Automates the collection step only; review stays human-driven.
 */
export const Route = createFileRoute("/api/public/cron/collect-uk-legislation")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await authenticateCronRequest(request);
        if (denied) return denied;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runUkLegislationCollection } = await import("@/lib/uk-legislation.server");

        try {
          const result = await runUkLegislationCollection(supabaseAdmin);
          return Response.json(
            { ok: true, ...result },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown failure";
          console.error("[cron/collect-uk-legislation] failed", message);
          return Response.json(
            { ok: false, error: message },
            { status: 500, headers: { "Cache-Control": "no-store" } },
          );
        }
      },
    },
  },
});
