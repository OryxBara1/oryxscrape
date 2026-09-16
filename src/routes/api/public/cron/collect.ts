import { createFileRoute } from "@tanstack/react-router";

import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

/**
 * Weekly scheduled collection trigger. Shared-secret authenticated; returns no
 * document content and no PII. Automates the collection step only.
 */
export const Route = createFileRoute("/api/public/cron/collect")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await authenticateCronRequest(request);
        if (denied) return denied;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runScheduledCollection } = await import("@/lib/scheduler.server");

        try {
          const result = await runScheduledCollection(supabaseAdmin);
          return Response.json(
            { ok: true, sources: result.sources, failed: result.failed },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          console.error("[cron/collect] failed", (error as Error).message);
          return Response.json({ ok: false }, { status: 500 });
        }
      },
    },
  },
});
