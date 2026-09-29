// OryxScrape public read API v1.0 — cheap change detection for registered consumers
import { createFileRoute } from "@tanstack/react-router";

/**
 * GET /api/public/feed/stats — lightweight poll endpoint so consumers can
 * detect new content without fetching the full feed.
 *
 * Auth: same as /api/public/feed (Authorization: Bearer <raw_key> or X-API-Key).
 *
 * Returns { total_eligible, last_updated_at } scoped to the key's profile
 * (allowed jurisdictions/tags and promotion rules are honored).
 * Consumers poll this every few minutes and only pull /api/public/feed
 * when last_updated_at is newer than their stored checkpoint.
 *
 * Raw keys are never logged. Self-contained — no shared auth middleware.
 */

function jsonError(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

function unauthorized() {
  return jsonError(401, "Unauthorized");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const Route = createFileRoute("/api/public/feed/stats")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const authHeader = request.headers.get("authorization") ?? "";
          const rawKey = authHeader.toLowerCase().startsWith("bearer ")
            ? authHeader.slice(7).trim()
            : (request.headers.get("x-api-key") ?? "").trim();
          if (rawKey.length < 9) return unauthorized();

          const namespaced = rawKey.split("_");
          const prefixes =
            namespaced.length === 3 && namespaced[0] === "oxs" && namespaced[1]
              ? [`oxs_${namespaced[1]}`]
              : [rawKey.slice(0, 8), `oxs_${rawKey.slice(0, 8)}`];
          const hash = await sha256Hex(rawKey);

          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

          const { data: keyRow, error: keyError } = await supabaseAdmin
            .from("consumer_keys")
            .select(
              "id, allowed_tags, profile_id, research_profiles(is_active, allowed_jurisdictions, allowed_tags, require_promotion)",
            )
            .in("key_prefix", prefixes)
            .eq("key_hash", hash)
            .eq("is_active", true)
            .is("revoked_at", null)
            .maybeSingle();

          if (keyError || !keyRow) return unauthorized();
          const profile = keyRow.research_profiles;
          if (!profile || !profile.is_active) return unauthorized();

          const buildQuery = (head: boolean) => {
            let q = supabaseAdmin
              .from("normalized_items")
              .select(
                profile.require_promotion
                  ? "id, normalized_item_profile_exposure!inner(profile_id, promoted)"
                  : "id",
                head ? { count: "exact", head: true } : undefined,
              )
              .eq("publication_status", "eligible");
            if (profile.require_promotion) {
              q = q
                .eq("normalized_item_profile_exposure.profile_id", keyRow.profile_id)
                .eq("normalized_item_profile_exposure.promoted", true);
            }
            const profileJur = profile.allowed_jurisdictions ?? [];
            if (profileJur.length > 0) q = q.in("jurisdiction_hint", profileJur);
            const tags =
              (keyRow.allowed_tags ?? []).length > 0
                ? keyRow.allowed_tags!
                : (profile.allowed_tags ?? []);
            if (tags.length > 0) q = q.overlaps("tags", tags);
            return q;
          };

          const [{ count, error: countError }, { data: latest, error: latestError }] =
            await Promise.all([
              buildQuery(true),
              buildQuery(false).order("updated_at", { ascending: false }).limit(1),
            ]);

          if (countError || latestError) {
            console.error("[api/public/feed/stats] query failed", countError?.message ?? latestError?.message);
            return jsonError(500, "Internal server error");
          }

          return Response.json(
            {
              total_eligible: count ?? 0,
              last_updated_at: latest?.[0]?.updated_at ?? null,
            },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (err) {
          console.error("[api/public/feed/stats] unexpected error", err);
          return jsonError(500, "Internal server error");
        }
      },
      POST: async () => jsonError(405, "Method not allowed"),
      PUT: async () => jsonError(405, "Method not allowed"),
      PATCH: async () => jsonError(405, "Method not allowed"),
      DELETE: async () => jsonError(405, "Method not allowed"),
    },
  },
});
