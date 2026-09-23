import { createFileRoute } from "@tanstack/react-router";

import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

/**
 * Scheduled Brazilian official gazette collection (Diário Oficial da União).
 * Shared-secret authenticated. Returns counts only — no document content,
 * no PII. Automates the collection step only; review stays human-driven.
 */
export const Route = createFileRoute("/api/public/cron/collect-br-dou")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await authenticateCronRequest(request);
        if (denied) return denied;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runBrDouCollection } = await import("@/lib/br-dou.server");

        try {
          const result = await runBrDouCollection(supabaseAdmin);
          return Response.json(
            { ok: true, ...result },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown failure";
          console.error("[cron/collect-br-dou] failed", message);
          return Response.json(
            { ok: false, error: message },
            { status: 500, headers: { "Cache-Control": "no-store" } },
          );
        }
      },
    },
  },
});
