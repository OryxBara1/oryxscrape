import { createFileRoute } from "@tanstack/react-router";

import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

/**
 * Scheduled Italian legislation collection (Normattiva open data API).
 * Shared-secret authenticated. Returns counts only — no document content,
 * no PII. Automates the collection step only; review stays human-driven.
 */
export const Route = createFileRoute("/api/public/cron/collect-it-normattiva")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await authenticateCronRequest(request);
        if (denied) return denied;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runNormattivaCollection } = await import("@/lib/normattiva-collect.server");

        try {
          const result = await runNormattivaCollection(supabaseAdmin);
          return Response.json(
            { ok: true, ...result },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown failure";
          console.error("[cron/collect-it-normattiva] failed", message);
          return Response.json(
            { ok: false, error: message },
            { status: 500, headers: { "Cache-Control": "no-store" } },
          );
        }
      },
    },
  },
});
