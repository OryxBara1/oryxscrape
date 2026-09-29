// OryxScrape public read API v1.0
import { createFileRoute } from "@tanstack/react-router";

/**
 * GET /api/public/feed — read-only feed of approved regulatory documents
 * for external consumer apps (e.g. AuraMaris).
 *
 * Auth: Authorization: Bearer <raw_key>
 *   raw key = {8-char prefix}{secret}; consumer_keys stores key_prefix + sha256 hex hash.
 *
 * Query params (all optional):
 *   since        ISO 8601 — items with updated_at > since (incremental pulls)
 *   jurisdiction repeatable — jurisdiction_hint IN (...)
 *   tags         repeatable — tags overlap; intersected with key's allowed_tags when set
 *   limit        1..500, default 100
 *   offset       >= 0, default 0
 *
 * Never exposes: raw_item_id, reviewed_by, payload, verification_status, publication_status.
 * Raw keys are never logged. Self-contained — no shared auth middleware.
 */

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

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

export const Route = createFileRoute("/api/public/feed")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const authHeader = request.headers.get("authorization") ?? "";
          const rawKey = authHeader.toLowerCase().startsWith("bearer ")
            ? authHeader.slice(7).trim()
            : (request.headers.get("x-api-key") ?? "").trim();
          if (rawKey.length < 9) return unauthorized();

          // Namespaced keys (oxs_<prefix>_<secret>) store "oxs_<prefix>"; legacy keys use the first 8 chars.
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

          const url = new URL(request.url);

          // --- query params ---
          const since = url.searchParams.get("since");
          if (since && Number.isNaN(Date.parse(since))) {
            return jsonError(400, "invalid since");
          }

          // Accept both repeated params (?jurisdiction=FR&jurisdiction=ES)
          // and comma-separated values (?jurisdiction=FR,ES) — AuraMaris sends the latter.
          const splitParam = (values: string[]) =>
            values
              .flatMap((v) => v.split(","))
              .map((v) => v.trim())
              .filter(Boolean);

          let jurisdictions = splitParam(url.searchParams.getAll("jurisdiction"));
          const profileJur = profile.allowed_jurisdictions ?? [];
          if (profileJur.length > 0) {
            // profile's countries take priority
            jurisdictions = jurisdictions.length > 0
              ? jurisdictions.filter((j) => profileJur.includes(j.toUpperCase()))
              : profileJur;
            if (jurisdictions.length === 0) return jsonError(400, "no requested jurisdictions are allowed for this key");
          }

          let tags = splitParam(url.searchParams.getAll("tags"));
          for (const allowedTags of [profile.allowed_tags ?? [], keyRow.allowed_tags ?? []]) {
            if (allowedTags.length === 0) continue;
            tags = tags.length > 0 ? tags.filter((t) => allowedTags.includes(t)) : allowedTags;
            if (tags.length === 0) return jsonError(400, "no requested tags are allowed for this key");
          }

          const limitParam = url.searchParams.get("limit");
          let limit = DEFAULT_LIMIT;
          if (limitParam !== null) {
            const parsed = Number.parseInt(limitParam, 10);
            if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
              return jsonError(400, "invalid limit");
            }
            limit = parsed;
          }

          const offsetParam = url.searchParams.get("offset");
          let offset = 0;
          if (offsetParam !== null) {
            const parsed = Number.parseInt(offsetParam, 10);
            if (!Number.isFinite(parsed) || parsed < 0) {
              return jsonError(400, "invalid offset");
            }
            offset = parsed;
          }

          // --- data query ---
          const baseCols =
            "id, source_url, jurisdiction_hint, category, payload, tags, traceability_level, institution_class, is_official_domain, is_primary_document, collected_at, reviewed_at, updated_at";
          let query = supabaseAdmin
            .from("normalized_items")
            .select(
              profile.require_promotion
                ? `${baseCols}, normalized_item_profile_exposure!inner(profile_id, promoted)`
                : baseCols,
              { count: "exact" },
            )
            .eq("publication_status", "eligible")
            .order("updated_at", { ascending: false })
            .range(offset, offset + limit - 1);

          if (profile.require_promotion) {
            query = query
              .eq("normalized_item_profile_exposure.profile_id", keyRow.profile_id)
              .eq("normalized_item_profile_exposure.promoted", true);
          }
          if (since) query = query.gt("updated_at", since);
          if (jurisdictions.length > 0) query = query.in("jurisdiction_hint", jurisdictions);
          if (tags.length > 0) query = query.overlaps("tags", tags);

          const { data, error, count } = await query;
          if (error) {
            console.error("[api/public/feed] query failed", error.message);
            return jsonError(500, "Internal server error");
          }

          // fire-and-forget: never block the response on last_used_at bookkeeping
          void supabaseAdmin
            .from("consumer_keys")
            .update({ last_used_at: new Date().toISOString() })
            .eq("id", keyRow.id)
            .then(undefined, () => undefined);

          type FeedRow = {
            id: string; source_url: string; jurisdiction_hint: string | null; category: string | null;
            payload: unknown; tags: string[] | null; traceability_level: string; institution_class: string;
            is_official_domain: boolean; is_primary_document: boolean; collected_at: string; reviewed_at: string | null;
          };
          const items = ((data ?? []) as unknown as FeedRow[]).map((row) => {
            const payload = (row.payload ?? {}) as Record<string, unknown>;
            const textContent =
              typeof payload["text"] === "string"
                ? (payload["text"] as string)
                : typeof payload["plain_text"] === "string"
                  ? (payload["plain_text"] as string)
                  : null;

            return {
              id: row.id,
              source_url: row.source_url,
              jurisdiction: row.jurisdiction_hint,
              category: row.category,
              title: typeof payload["title"] === "string" ? (payload["title"] as string) : null,
              doc_type: typeof payload["doc_type"] === "string" ? (payload["doc_type"] as string) : null,
              text: textContent,
              tags: row.tags ?? [],
              traceability_level: row.traceability_level,
              institution_class: row.institution_class,
              is_official_domain: row.is_official_domain,
              is_primary_document: row.is_primary_document,
              collected_at: row.collected_at,
              reviewed_at: row.reviewed_at,
            };
          });

          const total = count ?? items.length;
          return Response.json(
            {
              items,
              count: items.length,
              total,
              has_more: offset + items.length < total,
              offset,
              limit,
            },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (err) {
          console.error("[api/public/feed] unexpected error", err);
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
