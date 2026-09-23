/**
 * Scheduled collection (server-only).
 *
 * Automates ONLY the collection step. It reuses the exact same collection
 * internals the manual "Run collection" button uses and stops at raw_items /
 * normalized_items. Nothing here touches verification_status,
 * publication_status, profile promotion or the Drive handoff: every collected
 * item stays unreviewed / internal_only until a human acts on it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

import { postSlack } from "./slack-notify.server";

const MAX_PAGES = 25;
const COLLECTOR_VERSION = "apify-boe-static-url@1.0.0";

type ScheduledSource = Database["public"]["Tables"]["sources"]["Row"];

export type SourceRunResult = {
  sourceId: string;
  sourceName: string;
  jobId: string | null;
  status: "started" | "collected" | "failed";
  ingested?: number;
  duplicates?: number;
  error?: string;
};

async function recordFailure(
  supabase: SupabaseClient<Database>,
  source: ScheduledSource,
  message: string,
) {
  await supabase.from("audit_events").insert({
    check_type: "consistency",
    target_table: "sources",
    target_id: source.id,
    result: "failed",
    findings: {
      scope: "scheduled_collection",
      source_name: source.name,
      domain: source.domain,
      error: message,
    } as unknown as never,
  });
  await postSlack(
    `:rotating_light: OryxScrape scheduled collection failed for *${source.name}* (${source.domain})\n> ${message}`,
  );
}

async function collectOne(
  supabase: SupabaseClient<Database>,
  source: ScheduledSource,
): Promise<SourceRunResult> {
  const base = { sourceId: source.id, sourceName: source.name };
  try {
    if (source.collection_method === "api" && source.domain.includes("et.gr")) {
      const { runFekCollection } = await import("./fek-collect.server");
      const result = await runFekCollection({
        supabase,
        source,
        profileId: null,
        limit: 4,
      });
      return {
        ...base,
        jobId: result.jobId,
        status: "collected",
        ingested: result.ingested,
        duplicates: result.duplicates,
      };
    }

    if (source.collection_method === "api" && source.domain.includes("normattiva.it")) {
      const { runNormattivaCollection } = await import("./normattiva-collect.server");
      const result = await runNormattivaCollection(supabase);
      return {
        ...base,
        jobId: result.jobId,
        status: "collected",
        ingested: result.new_items,
        duplicates: result.duplicates,
      };
    }

    if (source.collection_method === "api" && source.domain.includes("boe.es")) {
      const { runBoeCollection } = await import("./boe-collect.server");
      const result = await runBoeCollection(supabase);
      return {
        ...base,
        jobId: result.jobId,
        status: "collected",
        ingested: result.new_items,
        duplicates: result.duplicates,
      };
    }

    if (
      source.collection_method === "api" &&
      source.domain.includes("legislation.gov.uk")
    ) {
      const { runUkLegislationCollection } = await import("./legislation-uk-collect.server");
      const result = await runUkLegislationCollection(supabase);
      return {
        ...base,
        jobId: result.jobId,
        status: "collected",
        ingested: result.new_items,
        duplicates: result.duplicates,
      };
    }

    if (source.collection_method === "api" && source.domain.includes("officielebekendmakingen.nl")) {
      const { runObkCollection } = await import("./obk-collect.server");
      const result = await runObkCollection(supabase);
      return {
        ...base,
        jobId: result.jobId,
        status: "collected",
        ingested: result.new_items,
        duplicates: result.duplicates,
      };
    }

    if (source.collection_method === "api" && source.domain.includes("dou.gov.br")) {
      const { runDouCollection } = await import("./dou-collect.server");
      const result = await runDouCollection(supabase);
      return {
        ...base,
        jobId: result.jobId,
        status: "collected",
        ingested: result.new_items,
        duplicates: result.duplicates,
      };
    }

    if (source.collection_method === "api") {


      const { runPisteCollection } = await import("./piste-collect.server");
      const { data: terms } = await supabase
        .from("search_terms")
        .select("concept_code, concept_label, term")
        .eq("country_code", "FR")
        .in("lifecycle_state", ["candidate", "promising", "validated"])
        .limit(15);
      const concepts = (terms ?? []).map((t) => ({
        concept_label: t.concept_label,
        query: t.term,
      }));
      if (!concepts.length) throw new Error("No active French search terms to run.");
      const result = await runPisteCollection({
        supabase,
        source,
        profileId: null,
        concepts,
        maxItems: 2,
      });
      return {
        ...base,
        jobId: result.jobId,
        status: "collected",
        ingested: result.ingested,
        duplicates: result.duplicates,
      };
    }

    if (source.collection_method === "http") {
      const { runPdfCollection } = await import("./pdf-collect.server");
      const result = await runPdfCollection({
        supabase,
        source,
        profileId: null,
        targets: [{ url: source.start_url }],
      });
      return {
        ...base,
        jobId: result.jobId,
        status: "collected",
        ingested: result.ingested,
        duplicates: result.duplicates,
      };
    }

    // Apify crawl: asynchronous, finalized by the follow-up pass.
    const crawlerType =
      source.crawler_type === "playwright:firefox" ? "playwright:firefox" : "cheerio";
    const includeUrlGlobs = source.include_url_globs ?? undefined;
    const maxCrawlPages = 10;

    const { data: job, error: jobError } = await supabase
      .from("collection_jobs")
      .insert({
        source_id: source.id,
        profile_id: null,
        status: "running",
        started_at: new Date().toISOString(),
        run_params: {
          trigger: "scheduled",
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
      await supabase
        .from("collection_jobs")
        .update({ apify_run_id: run.id })
        .eq("id", job.id);
      return { ...base, jobId: job.id, status: "started" };
    } catch (error) {
      const message = (error as Error).message;
      await supabase
        .from("collection_jobs")
        .update({
          status: "failed",
          finished_at: new Date().toISOString(),
          error_text: message,
        })
        .eq("id", job.id);
      throw new Error(message);
    }
  } catch (error) {
    const message = (error as Error).message;
    await recordFailure(supabase, source, message);
    return { ...base, jobId: null, status: "failed", error: message };
  }
}

/** Weekly pass: starts a collection for every scheduled source. */
export async function runScheduledCollection(supabase: SupabaseClient<Database>) {
  const { data: sources, error } = await supabase
    .from("sources")
    .select("*")
    .eq("schedule_enabled", true)
    .eq("is_active", true)
    .order("name");
  if (error) throw new Error(error.message);

  const results: SourceRunResult[] = [];
  for (const source of sources ?? []) {
    const result = await collectOne(supabase, source);
    results.push(result);
    await supabase
      .from("sources")
      .update({ last_scheduled_run_at: new Date().toISOString() })
      .eq("id", source.id);
  }

  const failed = results.filter((r) => r.status === "failed");
  const lines = results.map((r) =>
    r.status === "failed"
      ? `• ${r.sourceName}: failed — ${r.error}`
      : r.status === "started"
        ? `• ${r.sourceName}: crawl started`
        : `• ${r.sourceName}: ${r.ingested} new, ${r.duplicates} unchanged`,
  );
  await postSlack(
    `*OryxScrape weekly collection* — ${results.length} source(s), ${failed.length} failed.\n${lines.join("\n")}\n_All new items remain unreviewed / internal only._`,
  );

  return { sources: results.length, failed: failed.length, results };
}

/**
 * Bounded follow-up pass: syncs Apify runs started earlier the same day and
 * normalizes whatever landed. No permanent polling.
 */
export async function runScheduledFinalize(supabase: SupabaseClient<Database>) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: jobs, error } = await supabase
    .from("collection_jobs")
    .select("id, status, apify_run_id, source_id, run_params, sources(name)")
    .gte("created_at", since)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const synced: string[] = [];
  const normalized: { jobId: string; normalized: number; failed: number }[] = [];
  const failures: string[] = [];

  const { getRun, getDatasetItems } = await import("./apify.server");
  const { sha256Hex } = await import("./consumer-keys.server");
  const { runNormalizeJob } = await import("./normalize.server");

  for (const job of jobs ?? []) {
    try {
      if ((job.status === "running" || job.status === "queued") && job.apify_run_id) {
        const run = await getRun(job.apify_run_id);
        if (run.status === "READY" || run.status === "RUNNING" || run.status === "ABORTING") {
          continue;
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
          failures.push(`${job.sources?.name ?? job.source_id}: Apify ${run.status}`);
          continue;
        }

        const { data: facts } = await supabase
          .from("sources")
          .select(
            "is_official_domain, is_primary_document, traceability_level, institution_class",
          )
          .eq("id", job.source_id)
          .single();
        if (!facts) throw new Error("Source facts not found.");

        const pages = await getDatasetItems(run.defaultDatasetId, MAX_PAGES);
        const runParams = (job.run_params ?? {}) as { actor?: string };
        let ingested = 0;
        let duplicates = 0;
        let failedCount = 0;

        for (const page of pages) {
          const url = page.loadedUrl ?? page.url;
          const content = page.markdown ?? page.text ?? page.html ?? "";
          if (!url || !content.trim()) {
            failedCount += 1;
            continue;
          }
          const headers = page.metadata?.headers ?? {};
          const { error: insertError } = await supabase.from("raw_items").insert({
            job_id: job.id,
            source_id: job.source_id,
            source_url: url,
            raw_payload: page as unknown as never,
            content_hash: await sha256Hex(content),
            collected_at: new Date().toISOString(),
            collection_method: "apify",
            is_official_domain: facts.is_official_domain,
            is_primary_document: facts.is_primary_document,
            traceability_level: facts.traceability_level,
            institution_class: facts.institution_class,
            canonical_url: null,
            http_status: page.crawl?.httpStatusCode ?? null,
            content_type: headers["content-type"] ?? null,
            language: page.metadata?.languageCode ?? null,
            apify_actor_id: runParams.actor ?? null,
            apify_run_id: job.apify_run_id,
            collector_version: COLLECTOR_VERSION,
          });
          if (insertError) {
            if (insertError.code === "23505") duplicates += 1;
            else failedCount += 1;
          } else {
            ingested += 1;
          }
        }

        await supabase
          .from("collection_jobs")
          .update({
            status: "succeeded",
            finished_at: new Date().toISOString(),
            fetched_count: pages.length,
            new_count: ingested,
            duplicate_count: duplicates,
            failed_count: failedCount,
          })
          .eq("id", job.id);
        synced.push(job.id);
      }

      const result = await runNormalizeJob({ supabase, jobId: job.id, limit: MAX_PAGES });
      if (result.normalized || result.failed) {
        normalized.push({
          jobId: job.id,
          normalized: result.normalized,
          failed: result.failed,
        });
      }
    } catch (error) {
      const message = (error as Error).message;
      failures.push(`${job.sources?.name ?? job.source_id}: ${message}`);
      console.error("[scheduler] finalize failed", job.id, message);
    }
  }

  const totalNormalized = normalized.reduce((sum, n) => sum + n.normalized, 0);
  if (totalNormalized || failures.length) {
    await postSlack(
      `*OryxScrape weekly follow-up* — ${synced.length} run(s) synced, ${totalNormalized} document(s) normalized${
        failures.length ? `, ${failures.length} problem(s):\n> ${failures.join("\n> ")}` : "."
      }\n_All items remain unreviewed / internal only._`,
    );
  }

  return { synced: synced.length, normalized: totalNormalized, failures };
}
