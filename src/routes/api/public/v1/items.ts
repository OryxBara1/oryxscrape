import { createFileRoute } from "@tanstack/react-router";

/**
 * Public read API — GET /api/public/v1/items
 *
 * Auth:   Authorization: Bearer <consumer key>  (hashed match against consumer_keys)
 * Query:  updated_since=<ISO timestamp>   only items changed after this instant
 *         cursor=<opaque>                 keyset cursor returned as next_cursor
 *         limit=<1..200>                  server caps at 200 regardless of request
 * Return: { items: [...], next_cursor: string | null }
 *
 * Never returns raw payload of raw_items, key hashes, or policy bodies.
 * Raw keys are never logged.
 */

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

function unauthorized() {
  return Response.json(
    { error: "unauthorized" },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

export const Route = createFileRoute("/api/public/v1/items")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authHeader = request.headers.get("authorization") ?? "";
        if (!authHeader.toLowerCase().startsWith("bearer ")) return unauthorized();
        const rawKey = authHeader.slice(7).trim();
        if (!rawKey) return unauthorized();

        const { prefixFromRawKey, sha256Hex, timingSafeEqualHex, encodeCursor, decodeCursor } =
          await import("@/lib/consumer-keys.server");

        const keyPrefix = prefixFromRawKey(rawKey);
        if (!keyPrefix) return unauthorized();

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: keyRow, error: keyError } = await supabaseAdmin
          .from("consumer_keys")
          .select("id, profile_id, key_hash, is_active, revoked_at")
          .eq("key_prefix", keyPrefix)
          .maybeSingle();

        if (keyError || !keyRow) return unauthorized();
        if (!keyRow.is_active || keyRow.revoked_at) return unauthorized();

        const presentedHash = await sha256Hex(rawKey);
        if (!timingSafeEqualHex(presentedHash, keyRow.key_hash)) return unauthorized();

        const url = new URL(request.url);

        const updatedSinceParam = url.searchParams.get("updated_since");
        if (updatedSinceParam && Number.isNaN(Date.parse(updatedSinceParam))) {
          return Response.json({ error: "invalid updated_since" }, { status: 400 });
        }

        const cursorParam = url.searchParams.get("cursor");
        let cursor: { updatedAt: string; id: string } | null = null;
        if (cursorParam) {
          cursor = decodeCursor(cursorParam);
          if (!cursor) return Response.json({ error: "invalid cursor" }, { status: 400 });
        }

        const requestedLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
        const limit = Number.isFinite(requestedLimit)
          ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT)
          : DEFAULT_LIMIT;

        const { data, error } = await supabaseAdmin.rpc("api_list_items", {
          p_profile_id: keyRow.profile_id,
          p_updated_since: updatedSinceParam ?? undefined,
          p_cursor_updated_at: cursor?.updatedAt ?? undefined,
          p_cursor_id: cursor?.id ?? undefined,
          p_limit: limit + 1,
        });


        if (error) {
          console.error("[api/public/v1/items] rpc failed", error.message);
          return Response.json({ error: "internal error" }, { status: 500 });
        }

        const rows = data ?? [];
        const hasMore = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;
        const last = page[page.length - 1];

        // fire-and-forget: never block the response on last_used_at bookkeeping
        void supabaseAdmin
          .from("consumer_keys")
          .update({ last_used_at: new Date().toISOString() })
          .eq("id", keyRow.id)
          .then(undefined, () => undefined);

        return Response.json(
          {
            items: page.map((row) => ({
              id: row.id,
              source_url: row.source_url,
              jurisdiction_hint: row.jurisdiction_hint,
              category: row.category,
              payload: row.payload,
              tier_label: row.tier_label,
              policy_version: row.policy_version,
              collected_at: row.collected_at,
              updated_at: row.updated_at,
            })),
            next_cursor: hasMore && last ? encodeCursor(last.updated_at, last.id) : null,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    },
  },
});
