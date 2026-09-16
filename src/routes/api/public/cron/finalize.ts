import { createFileRoute } from "@tanstack/react-router";

import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

/**
 * Bounded follow-up pass for the weekly collection: syncs asynchronous Apify
 * runs and normalizes what landed. Shared-secret authenticated; no PII.
 */
export const Route = createFileRoute("/api/public/cron/finalize")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await authenticateCronRequest(request);
        if (denied) return denied;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runScheduledFinalize } = await import("@/lib/scheduler.server");

        try {
          const result = await runScheduledFinalize(supabaseAdmin);
          return Response.json(
            {
              ok: true,
              synced: result.synced,
              normalized: result.normalized,
              problems: result.failures.length,
            },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          console.error("[cron/finalize] failed", (error as Error).message);
          return Response.json({ ok: false }, { status: 500 });
        }
      },
    },
  },
});
