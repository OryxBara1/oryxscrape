import { createClient } from "@supabase/supabase-js";
import { startCrawl, getRun, getDatasetItems } from "./src/lib/apify.server";
import { sha256Hex } from "./src/lib/consumer-keys.server";
import { normalizeWithLogoriOn } from "./src/lib/logorion.server";

const supabase = createClient(
  process.env["VITE_SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
);

const COLLECTOR_VERSION = "apify-boe-static-url@1.0.0";

function canon(v?: string | null) {
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOne(sourceId: string) {
  const { data: source } = await supabase
    .from("sources")
    .select(
      "id, name, start_url, is_active, crawler_type, include_url_globs, is_official_domain, is_primary_document, traceability_level, institution_class",
    )
    .eq("id", sourceId)
    .single();
  const s = source as any;
  const crawlerType = s.crawler_type === "playwright:firefox" ? "playwright:firefox" : "cheerio";
  const includeUrlGlobs = s.include_url_globs ?? undefined;
  const maxCrawlPages = 5;

  const { data: job } = await supabase
    .from("collection_jobs")
    .insert({
      source_id: s.id,
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

  const run = await startCrawl({
    startUrl: s.start_url,
    maxCrawlPages,
    crawlerType,
    includeUrlGlobs,
  });
  await supabase.from("collection_jobs").update({ apify_run_id: run.id }).eq("id", job!.id);

  let final = run;
  for (let i = 0; i < 60; i++) {
    await sleep(10000);
    final = await getRun(run.id);
    if (!["READY", "RUNNING", "ABORTING"].includes(final.status)) break;
  }
  if (final.status !== "SUCCEEDED") {
    await supabase
      .from("collection_jobs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_text: `Apify run ended with status ${final.status}`,
      })
      .eq("id", job!.id);
    return { source: s.name, error: `run ${final.status}` };
  }

  const pages = await getDatasetItems(final.defaultDatasetId, 25);
  const rawIds: string[] = [];
  let ingested = 0,
    duplicates = 0,
    failed = 0;
  for (const page of pages) {
    const url = page.loadedUrl ?? page.url;
    const content = page.markdown ?? page.text ?? page.html ?? "";
    if (!url || !content.trim()) {
      failed++;
      continue;
    }
    const headers = page.metadata?.headers ?? {};
    const { data: row, error } = await supabase
      .from("raw_items")
      .insert({
        job_id: job!.id,
        source_id: s.id,
        source_url: url,
        raw_payload: page as any,
        content_hash: await sha256Hex(content),
        collected_at: new Date().toISOString(),
        collection_method: "apify",
        is_official_domain: s.is_official_domain,
        is_primary_document: s.is_primary_document,
        traceability_level: s.traceability_level,
        institution_class: s.institution_class,
        canonical_url: canon(page.metadata?.canonicalUrl),
        http_status: page.crawl?.httpStatusCode ?? null,
        content_type: (headers as any)["content-type"] ?? null,
        language: page.metadata?.languageCode ?? null,
        apify_actor_id: "apify~website-content-crawler",
        apify_run_id: run.id,
        collector_version: COLLECTOR_VERSION,
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") duplicates++;
      else failed++;
    } else {
      ingested++;
      rawIds.push(row!.id);
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
      failed_count: failed,
    })
    .eq("id", job!.id);

  const results: any[] = [];
  for (const rawId of rawIds) {
    const { data: item } = await supabase
      .from("raw_items")
      .select(
        "id, source_id, source_url, raw_payload, collected_at, is_official_domain, is_primary_document, traceability_level, institution_class",
      )
      .eq("id", rawId)
      .single();
    const p = (item!.raw_payload ?? {}) as any;
    const content = p.markdown ?? p.text ?? p.html ?? "";
    try {
      const doc = await normalizeWithLogoriOn({ sourceUrl: item!.source_url, content });
      const { error } = await supabase.from("normalized_items").insert({
        raw_item_id: item!.id,
        source_id: item!.source_id,
        source_url: item!.source_url,
        jurisdiction_hint: doc.jurisdiction_hint,
        category: doc.category,
        payload: doc as any,
        is_official_domain: item!.is_official_domain,
        is_primary_document: item!.is_primary_document,
        traceability_level: item!.traceability_level,
        institution_class: item!.institution_class,
        collected_at: item!.collected_at,
      });
      results.push({
        url: item!.source_url,
        title: (doc as any).title,
        category: doc.category,
        jurisdiction: doc.jurisdiction_hint,
        error: error?.message,
      });
    } catch (e) {
      results.push({ url: item!.source_url, error: (e as Error).message });
    }
  }
  return { source: s.name, pages: pages.length, ingested, duplicates, failed, results };
}

const ids = process.argv.slice(2);
for (const id of ids) {
  const out = await runOne(id);
  console.log(JSON.stringify(out, null, 2));
}
