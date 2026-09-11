import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

export const Route = createFileRoute("/api/public/tmp-renorm")({
  server: {
    handlers: {
      POST: async () => {
        const url = process.env["VITE_SUPABASE_URL"]!;
        const serviceKey = process.env["SUPABASE_SERVICE_ROLE_KEY"]!;
        const admin = createClient(url, serviceKey, {
          auth: { persistSession: false },
        });
        const { data: raw, error } = await admin
          .from("raw_items")
          .select("id, source_url, content")
          .eq("id", "6627656d-71fc-47de-a4b6-c93b305ea42f")
          .single();
        if (error || !raw) {
          return Response.json({ ok: false, step: "fetch_raw", error });
        }
        try {
          const { normalizeWithLogoriOn } = await import(
            "@/lib/logorion.server"
          );
          const doc = await normalizeWithLogoriOn({
            sourceUrl: raw.source_url,
            content: raw.content ?? "",
          });
          return Response.json({ ok: true, doc });
        } catch (e) {
          return Response.json(
            { ok: false, step: "logorion", error: (e as Error).message },
            { status: 502 },
          );
        }
      },
    },
  },
});
