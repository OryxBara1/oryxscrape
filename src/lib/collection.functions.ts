import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Phase 5 pipeline (manual trigger only — no scheduling yet):
 *   Apify crawl -> raw_items (immutable, facts snapshotted, tagged with job id)
 *   -> LogoriOn normalization -> normalized_items
 *   -> tier computed on read by the guarded api_list_items RPC.
 */

const MAX_PAGES = 25;

/** Bumped by hand whenever the collector's extraction behaviour changes. */
const COLLECTOR_VERSION = "apify-boe-static-url@1.0.0";

/**
 * Deterministic, server-side only. Never inferred by LogoriOn: we take the
 * provider-reported canonical link and accept it only when it is an absolute
 * http(s) URL, then normalise it. Anything else stays NULL.
 */
function deterministicCanonicalUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}


export const startCollectionJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      sourceId: string;
      profileId?: string | null;
      maxPages?: number;
      query?: string;
      concepts?: { concept_label: string; query: string }[];
      /** Direct document URLs, used by `http` sources (e.g. PDF-only portals). */
      documents?: { url: string; document_label?: string }[];
      language?: string | null;
    }) => input,
  )

  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: source, error: sourceError } = await supabase
      .from("sources")
      .select(
        "id, start_url, collection_method, is_active, crawler_type, include_url_globs, is_official_domain, is_primary_document, traceability_level, institution_class",
      )
      .eq("id", data.sourceId)
      .single();
    if (sourceError) throw new Error(sourceError.message);
    if (!source.is_active) throw new Error("This source is not active.");

    // Authenticated structured APIs (e.g. PISTE / Légifrance) are fetched
    // synchronously here; there is no external run to poll afterwards.
    if (source.collection_method === "api") {
      const { runPisteCollection } = await import("./piste-collect.server");
      const concepts =
        data.concepts?.length
          ? data.concepts
          : [{ concept_label: "default", query: data.query ?? "permis plaisance" }];
      return runPisteCollection({
        supabase,
        source,
        profileId: data.profileId ?? null,
        concepts,
        maxItems: Math.min(Math.max(data.maxPages ?? 2, 1), 5),
      });
    }

    // PDF-only portals: the documents are fetched directly and their text layer
    // extracted server-side, because no crawler can parse application/pdf.
    if (source.collection_method === "http") {
      const { runPdfCollection } = await import("./pdf-collect.server");
      const targets = data.documents?.length
        ? data.documents
        : [{ url: source.start_url }];
      return runPdfCollection({
        supabase,
        source,
        profileId: data.profileId ?? null,
        targets,
        language: data.language ?? null,
      });
    }




    const maxCrawlPages = Math.min(Math.max(data.maxPages ?? 10, 1), MAX_PAGES);
    const crawlerType =
      source.crawler_type === "playwright:firefox" ? "playwright:firefox" : "cheerio";
    const includeUrlGlobs = source.include_url_globs ?? undefined;


    const { data: job, error: jobError } = await supabase
      .from("collection_jobs")
      .insert({
        source_id: source.id,
        profile_id: data.profileId ?? null,
        status: "running",
        started_at: new Date().toISOString(),
        run_params: {
          actor: "apify~website-content-crawler",
          maxCrawlPages,
          crawlerType,
          ...(includeUrlGlobs?.length ? { includeUrlGlobs } : {}),
        },
      })
      .select("id")
      .single();
    if (jobError) throw new Error(jobError.message);

    try {
      const { startCrawl } = await import("./apify.server");
      const run = await startCrawl({
        startUrl: source.start_url,
        maxCrawlPages,
        crawlerType,
        ...(includeUrlGlobs?.length ? { includeUrlGlobs } : {}),
      });

      const { error } = await supabase
        .from("collection_jobs")
        .update({ apify_run_id: run.id })
        .eq("id", job.id);
      if (error) throw new Error(error.message);
      return { jobId: job.id, apifyRunId: run.id };

    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start the crawl.";
      await supabase
        .from("collection_jobs")
        .update({ status: "failed", finished_at: new Date().toISOString(), error_text: message })
        .eq("id", job.id);
      throw new Error(message);
    }
  });

export const syncCollectionJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { jobId: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: job, error: jobError } = await supabase
      .from("collection_jobs")
      .select("id, status, apify_run_id, source_id, run_params, sources(is_official_domain, is_primary_document, traceability_level, institution_class)")
      .eq("id", data.jobId)
      .single();
    if (jobError) throw new Error(jobError.message);
    if (!job.apify_run_id) throw new Error("This job has no Apify run attached.");
    if (job.status !== "running" && job.status !== "queued") {
      return { status: job.status, ingested: 0, duplicates: 0 };
    }

    const { getRun, getDatasetItems } = await import("./apify.server");
    const run = await getRun(job.apify_run_id);

    if (run.status === "READY" || run.status === "RUNNING" || run.status === "ABORTING") {
      return { status: "running" as const, ingested: 0, duplicates: 0 };
    }

    if (run.status !== "SUCCEEDED") {
      await supabase
        .from("collection_jobs")
        .update({
          status: run.status === "ABORTED" ? "cancelled" : "failed",
          finished_at: new Date().toISOString(),
          error_text: `Apify run ended with status ${run.status}`,
        })
        .eq("id", job.id);
      return { status: "failed" as const, ingested: 0, duplicates: 0 };
    }

    const pages = await getDatasetItems(run.defaultDatasetId, MAX_PAGES);
    const { sha256Hex } = await import("./consumer-keys.server");
    const facts = job.sources!;
    const runParams = (job.run_params ?? {}) as { actor?: string };
    const actorId = runParams.actor ?? null;


    let ingested = 0;
    let duplicates = 0;
    let failed = 0;

    for (const page of pages) {
      const url = page.loadedUrl ?? page.url;
      const content = page.markdown ?? page.text ?? page.html ?? "";
      if (!url || !content.trim()) {
        failed += 1;
        continue;
      }
      const contentHash = await sha256Hex(content);
      const headers = page.metadata?.headers ?? {};
      const { error } = await supabase.from("raw_items").insert({
        job_id: job.id,
        source_id: job.source_id,
        source_url: url,
        raw_payload: page as unknown as never,
        content_hash: contentHash,
        collected_at: new Date().toISOString(),
        collection_method: "apify",
        // objective facts are physically snapshotted at insert time
        is_official_domain: facts.is_official_domain,
        is_primary_document: facts.is_primary_document,
        traceability_level: facts.traceability_level,
        institution_class: facts.institution_class,
        // provenance: only what the provider objectively supplies, else NULL
        canonical_url: deterministicCanonicalUrl(page.metadata?.canonicalUrl),
        http_status: page.crawl?.httpStatusCode ?? null,
        content_type: headers["content-type"] ?? null,
        language: page.metadata?.languageCode ?? null,
        apify_actor_id: actorId,
        apify_run_id: job.apify_run_id,
        collector_version: COLLECTOR_VERSION,
      });

      if (error) {
        if (error.code === "23505") duplicates += 1;
        else failed += 1;
      } else {
        ingested += 1;
      }
    }

    const { error: updateError } = await supabase
      .from("collection_jobs")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        fetched_count: pages.length,
        new_count: ingested,
        duplicate_count: duplicates,
        failed_count: failed,
      })
      .eq("id", job.id);
    if (updateError) throw new Error(updateError.message);

    return { status: "succeeded" as const, ingested, duplicates };
  });

export const normalizeCollectionJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { jobId: string; limit?: number }) => input)
  .handler(async ({ data, context }) => {
    const limit = Math.min(Math.max(data.limit ?? 10, 1), MAX_PAGES);
    const { runNormalizeJob } = await import("./normalize.server");
    return runNormalizeJob({ supabase: context.supabase, jobId: data.jobId, limit });
  });

