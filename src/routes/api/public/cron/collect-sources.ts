import { createFileRoute } from "@tanstack/react-router";

import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

/**
 * Generic scheduled collection dispatcher.
 *
 * Reads active sources, fetches each start page through Parallel Extract and
 * stores one immutable raw item per source. Shared-secret authenticated.
 *
 * Boundaries: no review state is touched — every item stays unreviewed /
 * internal_only; raw_items are insert-only, deduplicated by SHA-256.
 */

const COLLECTOR_VERSION = "collect-sources-v1";
const CONCURRENCY = 6;
const SKIP_WINDOW_DAYS = 7;
const EXTRACT_MAX_CHARS = 30000;

type ExtractResult = {
  title: string | null;
  publishDate: string | null;
  content: string;
  usage: unknown;
  httpStatus: number;
};

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Parallel Extract. Gateway-backed connections carry a `lovc_` connection key
 * and must be called through the Lovable connector gateway; a direct provider
 * key (older connection style) calls api.parallel.ai instead.
 */
async function parallelExtract(url: string, sourceName: string): Promise<ExtractResult> {
  const parallelKey = process.env["PARALLEL_API_KEY"];
  if (!parallelKey) throw new Error("PARALLEL_API_KEY is not configured");

  const usesGateway = parallelKey.startsWith("lovc_");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let endpoint: string;

  if (usesGateway) {
    const lovableKey = process.env["LOVABLE_API_KEY"];
    if (!lovableKey) throw new Error("LOVABLE_API_KEY is not configured");
    endpoint = "https://connector-gateway.lovable.dev/parallel/v1/extract";
    headers["Authorization"] = `Bearer ${lovableKey}`;
    headers["X-Connection-Api-Key"] = parallelKey;
  } else {
    endpoint = "https://api.parallel.ai/v1/extract";
    headers["x-api-key"] = parallelKey;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      urls: [url],
      objective: `Extract the real regulatory/gazette content from this official page (Source: ${sourceName}).`,
      excerpts: false,
      full_content: { max_chars_per_result: EXTRACT_MAX_CHARS },
      max_chars_total: EXTRACT_MAX_CHARS,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Parallel Extract failed [${response.status}]: ${body.slice(0, 500)}`);
  }

  const payload = (await response.json()) as {
    results?: Array<{
      title?: string | null;
      publish_date?: string | null;
      full_content?: string | null;
      content?: string | null;
      excerpts?: string[] | null;
    }>;
    usage?: unknown;
  };

  const first = payload.results?.[0];
  const content =
    first?.full_content ?? first?.content ?? (first?.excerpts ?? []).join("\n\n") ?? "";
  if (!content.trim()) {
    throw new Error("Parallel Extract returned no content for this page");
  }

  return {
    title: first?.title ?? null,
    publishDate: first?.publish_date ?? null,
    content,
    usage: payload.usage ?? null,
    httpStatus: response.status,
  };
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

export const Route = createFileRoute("/api/public/cron/collect-sources")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await authenticateCronRequest(request);
        if (denied) return denied;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        let body: { scope?: string; source_domain?: string } = {};
        try {
          const text = await request.text();
          if (text.trim()) body = JSON.parse(text);
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        const scope = body.scope === "single" ? "single" : "all";
        const sourceDomain = typeof body.source_domain === "string" ? body.source_domain.trim() : "";
        if (scope === "single" && !sourceDomain) {
          return Response.json(
            { error: 'scope="single" requires "source_domain"' },
            { status: 400 },
          );
        }

        try {
          let query = supabaseAdmin
            .from("sources")
            .select(
              "id, name, domain, start_url, is_official_domain, is_primary_document, traceability_level, institution_class",
            )
            .eq("is_active", true);
          if (scope === "single") query = query.eq("domain", sourceDomain);

          const { data: sources, error: sourcesError } = await query;
          if (sourcesError) throw new Error(sourcesError.message);

          const all = sources ?? [];
          const cutoff = new Date(Date.now() - SKIP_WINDOW_DAYS * 86400000).toISOString();

          const results = await runWithConcurrency(all, CONCURRENCY, async (source) => {
            const startedAt = Date.now();
            const base = { source_domain: source.domain };
            try {
              const { data: recent, error: recentError } = await supabaseAdmin
                .from("raw_items")
                .select("id")
                .eq("source_id", source.id)
                .gte("collected_at", cutoff)
                .limit(1)
                .maybeSingle();
              if (recentError) throw new Error(recentError.message);
              if (recent) {
                return {
                  ...base,
                  status: "skipped" as const,
                  timing_ms: Date.now() - startedAt,
                  chars: 0,
                  usage: null,
                  reason: `collected within the last ${SKIP_WINDOW_DAYS} days`,
                };
              }

              const extracted = await parallelExtract(source.start_url, source.name);
              const collectedAt = new Date().toISOString();
              const contentHash = await sha256Hex(extracted.content);

              const { data: job, error: jobError } = await supabaseAdmin
                .from("collection_jobs")
                .insert({
                  source_id: source.id,
                  profile_id: null,
                  status: "succeeded",
                  started_at: new Date(startedAt).toISOString(),
                  finished_at: collectedAt,
                  fetched_count: 1,
                  new_count: 1,
                  run_params: {
                    function: "collect-sources",
                    job_type: "scheduled",
                    engine: COLLECTOR_VERSION,
                    scope,
                    usage: extracted.usage,
                  } as unknown as never,
                })
                .select("id")
                .single();
              if (jobError) throw new Error(jobError.message);

              const { data: inserted, error: rawError } = await supabaseAdmin
                .from("raw_items")
                .insert({
                  job_id: job.id,
                  source_id: source.id,
                  source_url: source.start_url,
                  canonical_url: source.start_url,
                  raw_payload: {
                    title: extracted.title,
                    publish_date: extracted.publishDate,
                    content: extracted.content,
                  } as unknown as never,
                  content_hash: contentHash,
                  collected_at: collectedAt,
                  collection_method: "parallel_extract",
                  http_status: extracted.httpStatus,
                  content_type: "text/markdown",
                  collector_version: COLLECTOR_VERSION,
                  is_official_domain: source.is_official_domain,
                  is_primary_document: source.is_primary_document,
                  traceability_level: source.traceability_level,
                  institution_class: source.institution_class,
                })
                .select("id")
                .maybeSingle();

              if (rawError) {
                // Duplicate content hash is not a failure: the evidence already exists.
                if (rawError.code === "23505") {
                  return {
                    ...base,
                    status: "duplicate" as const,
                    timing_ms: Date.now() - startedAt,
                    chars: extracted.content.length,
                    usage: extracted.usage,
                    inserted: null,
                  };
                }
                throw new Error(rawError.message);
              }

              return {
                ...base,
                status: "succeeded" as const,
                timing_ms: Date.now() - startedAt,
                chars: extracted.content.length,
                usage: extracted.usage,
                inserted: inserted?.id ?? null,
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : "Unknown failure";
              console.error(`[cron/collect-sources] ${source.domain} failed:`, message);
              return {
                ...base,
                status: "failed" as const,
                timing_ms: Date.now() - startedAt,
                chars: 0,
                usage: null,
                error: message,
              };
            }
          });

          const summary = {
            total: all.length,
            skipped: results.filter((r) => r.status === "skipped").length,
            attempted: results.filter((r) => r.status !== "skipped").length,
            succeeded: results.filter((r) => r.status === "succeeded" || r.status === "duplicate")
              .length,
            failed: results.filter((r) => r.status === "failed").length,
          };

          return Response.json(
            { summary, results },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown failure";
          console.error("[cron/collect-sources] failed", message);
          return Response.json(
            { error: message },
            { status: 500, headers: { "Cache-Control": "no-store" } },
          );
        }
      },
    },
  },
});
