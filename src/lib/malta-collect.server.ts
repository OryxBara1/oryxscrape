/**
 * Malta (transport.gov.mt) collector — server-only.
 *
 * Engine hierarchy is fixed and must never be reordered:
 *   1. Direct HTTP  2. Parallel Extract  3. Apify  4. Manual (recordBlockedItem)
 *
 * raw_items are immutable: a retry that succeeds inserts a NEW raw item that
 * supersedes the blocked one. Nothing here reviews or publishes anything.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

import { recordBlockedItem } from "./blocked-items.server";
import { sha256Hex } from "./consumer-keys.server";
import { extractWithParallel, searchWithParallel } from "./parallel-fetch.server";

export const COLLECTOR_VERSION = "malta-collect@1.0.0";
const MALTA_HOST = "transport.gov.mt";
const MIN_HTML_CHARS = 1000;
const MIN_PARALLEL_CHARS = 200;
const APIFY_ACTOR = "apify~website-content-crawler";

type Db = SupabaseClient<Database>;
type Engine = "http" | "parallel_extract" | "apify";
type Attempt = { engine: Engine; ok: boolean; chars: number; error?: string };

export type MaltaDocumentResult = {
  ok: boolean;
  text: string | null;
  title: string | null;
  engine: Engine | null;
  collectorVersion: string;
  httpStatus: number | null;
  contentType: string | null;
  attempts: Attempt[];
};

type SourceFacts = {
  id: string;
  start_url: string;
  is_official_domain: boolean;
  is_primary_document: boolean;
  traceability_level: Database["public"]["Enums"]["traceability_level"];
  institution_class: Database["public"]["Enums"]["institution_class"];
};

export async function getMaltaSource(supabase: Db): Promise<SourceFacts> {
  const { data, error } = await supabase
    .from("sources")
    .select("id, start_url, is_official_domain, is_primary_document, traceability_level, institution_class")
    .ilike("start_url", `%${MALTA_HOST}%`)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(error.message);
  const source = data?.[0];
  if (!source) throw new Error("No transport.gov.mt source found in sources.");
  return source;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0000/g, "")
    .trim();
}

function htmlTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m?.[1] ? htmlToText(m[1]).slice(0, 300) || null : null;
}

async function pdfToText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n") : text).replace(/\u0000/g, "").trim();
}

function isPdf(bytes: Uint8Array, contentType: string | null): boolean {
  if (contentType?.toLowerCase().includes("pdf")) return true;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

function isMaltaDocumentUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith(MALTA_HOST)) return false;
    return /\.pdf($|[-?#])/i.test(u.pathname + u.search) || /-f\d+$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** Document URLs from the listing page: HTTP first, Parallel Search as fallback. */
export async function discoverMaltaDocuments(
  startUrl: string,
): Promise<{ urls: string[]; via: "http" | "parallel_search"; error?: string }> {
  let httpError: string | undefined;
  try {
    const response = await fetch(startUrl, {
      headers: { Accept: "text/html,*/*;q=0.8", "User-Agent": "Mozilla/5.0 (regulatory document collection)" },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const urls = new Set<string>();
    for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
      try {
        const abs = new URL(m[1]!.replace(/&amp;/g, "&"), startUrl).toString();
        if (isMaltaDocumentUrl(abs)) urls.add(abs);
      } catch {
        /* ignore malformed href */
      }
    }
    if (urls.size) return { urls: [...urls], via: "http" };
    httpError = "HTTP listing returned no document links";
  } catch (error) {
    httpError = (error as Error).message;
  }

  const { hits } = await searchWithParallel(
    `transport.gov.mt maritime regulations notices PDF ${startUrl}`,
    20,
  );
  const urls = [...new Set(hits.map((h) => h.url).filter(isMaltaDocumentUrl))];
  return { urls, via: "parallel_search", error: httpError };
}

async function tryHttp(url: string): Promise<{ text: string; title: string | null; status: number; contentType: string | null }> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/pdf,text/html;q=0.9,*/*;q=0.8",
      "User-Agent": "Mozilla/5.0 (regulatory document collection)",
    },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers.get("content-type");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (isPdf(bytes, contentType)) {
    const text = await pdfToText(bytes);
    if (!text) throw new Error("PDF has no extractable text layer.");
    return { text, title: null, status: response.status, contentType };
  }
  const html = new TextDecoder("utf-8").decode(bytes);
  const text = htmlToText(html);
  if (text.length < MIN_HTML_CHARS) throw new Error(`HTML too short (${text.length} chars)`);
  return { text, title: htmlTitle(html), status: response.status, contentType };
}

async function tryApify(url: string): Promise<{ text: string; title: string | null }> {
  const token = process.env["APIFY_API_TOKEN"];
  if (!token) throw new Error("APIFY_API_TOKEN is not configured");
  const response = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?timeout=180&clean=true`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        startUrls: [{ url }],
        maxCrawlPages: 1,
        maxCrawlDepth: 0,
        crawlerType: "playwright:firefox",
        saveMarkdown: true,
        proxyConfiguration: { useApifyProxy: true },
      }),
    },
  );
  const body = await response.text();
  if (!response.ok) throw new Error(`Apify failed [${response.status}]: ${body.slice(0, 300)}`);
  const items = JSON.parse(body) as { text?: string; markdown?: string; metadata?: { title?: string } }[];
  const first = items[0];
  const text = (first?.text || first?.markdown || "").trim();
  if (!text) throw new Error("Apify returned no text");
  return { text, title: first?.metadata?.title ?? null };
}

/** Tries every engine in the fixed order and stops at the first success. */
export async function collectMaltaDocument(url: string): Promise<MaltaDocumentResult> {
  const attempts: Attempt[] = [];
  const base = { collectorVersion: COLLECTOR_VERSION };

  try {
    const r = await tryHttp(url);
    attempts.push({ engine: "http", ok: true, chars: r.text.length });
    return { ...base, ok: true, text: r.text, title: r.title, engine: "http", httpStatus: r.status, contentType: r.contentType, attempts };
  } catch (e) {
    attempts.push({ engine: "http", ok: false, chars: 0, error: (e as Error).message });
  }

  try {
    const r = await extractWithParallel(url, "Extract the full text of this Maltese maritime regulatory document.");
    if ((r.text ?? "").trim().length < MIN_PARALLEL_CHARS) {
      throw new Error(`Parallel text too short (${(r.text ?? "").trim().length} chars)`);
    }
    attempts.push({ engine: "parallel_extract", ok: true, chars: r.text.length });
    return { ...base, ok: true, text: r.text, title: r.title, engine: "parallel_extract", httpStatus: null, contentType: null, attempts };
  } catch (e) {
    attempts.push({ engine: "parallel_extract", ok: false, chars: 0, error: (e as Error).message });
  }

  try {
    const r = await tryApify(url);
    attempts.push({ engine: "apify", ok: true, chars: r.text.length });
    return { ...base, ok: true, text: r.text, title: r.title, engine: "apify", httpStatus: null, contentType: null, attempts };
  } catch (e) {
    attempts.push({ engine: "apify", ok: false, chars: 0, error: (e as Error).message });
  }

  return { ...base, ok: false, text: null, title: null, engine: null, httpStatus: null, contentType: null, attempts };
}

function summarizeFailure(attempts: Attempt[]): string {
  return attempts
    .filter((a) => !a.ok)
    .map((a) => `${a.engine}: ${a.error ?? "failed"}`)
    .join(" | ")
    .slice(0, 500);
}

async function insertCollected(input: {
  supabase: Db;
  source: SourceFacts;
  url: string;
  jobId: string;
  result: MaltaDocumentResult;
  supersedesId?: string;
}): Promise<"ingested" | "duplicate"> {
  const { supabase, source, result } = input;
  const text = result.text!;
  const { error } = await supabase.from("raw_items").insert({
    job_id: input.jobId,
    source_id: source.id,
    source_url: input.url,
    raw_payload: {
      text,
      plain_text: text,
      title: result.title,
      jurisdiction_hint: "MT",
      engine: result.engine,
      attempts: result.attempts,
    } as unknown as never,
    content_hash: await sha256Hex(text),
    collected_at: new Date().toISOString(),
    collection_method: result.engine!,
    is_official_domain: source.is_official_domain,
    is_primary_document: source.is_primary_document,
    traceability_level: source.traceability_level,
    institution_class: source.institution_class,
    canonical_url: input.url,
    http_status: result.httpStatus,
    content_type: result.contentType,
    language: "en",
    collector_version: COLLECTOR_VERSION,
    payload_integrity: "verbatim",
    item_status: "collected",
    ...(input.supersedesId ? { supersedes_raw_item_id: input.supersedesId } : {}),
  });
  if (error) {
    if (error.code === "23505") return "duplicate";
    throw new Error(error.message);
  }
  return "ingested";
}

async function createJob(supabase: Db, sourceId: string, profileId: string | null, runParams: Record<string, unknown>) {
  const { data, error } = await supabase
    .from("collection_jobs")
    .insert({
      source_id: sourceId,
      profile_id: profileId,
      status: "running",
      started_at: new Date().toISOString(),
      run_params: runParams as never,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id;
}

async function finishJob(
  supabase: Db,
  jobId: string,
  counts: { fetched: number; ingested: number; duplicates: number; failed: number },
  errorText?: string,
) {
  await supabase
    .from("collection_jobs")
    .update({
      status: errorText ? "failed" : "succeeded",
      finished_at: new Date().toISOString(),
      fetched_count: counts.fetched,
      new_count: counts.ingested,
      duplicate_count: counts.duplicates,
      failed_count: counts.failed,
      ...(errorText ? { error_text: errorText } : {}),
    })
    .eq("id", jobId);
}

export async function runMaltaCollection(input: {
  supabase: Db;
  profileId?: string | null | undefined;
  urls?: string[] | undefined;
  maxDocuments?: number | undefined;
}) {
  const { supabase } = input;
  const source = await getMaltaSource(supabase);
  const max = Math.min(Math.max(input.maxDocuments ?? 10, 1), 25);
  const jobId = await createJob(supabase, source.id, input.profileId ?? null, {
    method: "malta-collect",
    collector_version: COLLECTOR_VERSION,
    max_documents: max,
    ...(input.urls?.length ? { urls: input.urls } : {}),
  });

  const counts = { fetched: 0, ingested: 0, duplicates: 0, failed: 0 };
  let blocked = 0;
  try {
    // The start page itself is a document too; discovered links follow it.
    const urls = input.urls?.length
      ? input.urls
      : [...new Set([source.start_url, ...(await discoverMaltaDocuments(source.start_url).catch(() => ({ urls: [] as string[] }))).urls])];
    const targets = urls.slice(0, max);
    counts.fetched = targets.length;

    for (const url of targets) {
      const result = await collectMaltaDocument(url);
      if (result.ok) {
        const outcome = await insertCollected({ supabase, source, url, jobId, result });
        if (outcome === "ingested") counts.ingested += 1;
        else counts.duplicates += 1;
        continue;
      }
      counts.failed += 1;
      try {
        const rec = await recordBlockedItem({
          supabase,
          source,
          url,
          error: summarizeFailure(result.attempts),
          jobId,
          jurisdictionHint: "MT",
          attempts: result.attempts,
          collectorVersion: COLLECTOR_VERSION,
        });
        if (rec === "recorded") blocked += 1;
      } catch (e) {
        console.error("[malta-collect] blocked-record failed", url, (e as Error).message);
      }
    }
    await finishJob(supabase, jobId, counts);
    return {
      jobId,
      found: urls.length,
      ingested: counts.ingested,
      duplicates: counts.duplicates,
      blocked,
      failed: counts.failed,
    };
  } catch (error) {
    const message = (error as Error).message;
    await finishJob(supabase, jobId, counts, message);
    throw new Error(message);
  }
}

/** Retries still-open blocked Malta items through the same engine chain. */
export async function runMaltaRetroactivePass(input: { supabase: Db; limit?: number | undefined }) {
  const { supabase } = input;
  const source = await getMaltaSource(supabase);
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 15);

  const { data: blockedRows, error } = await supabase
    .from("raw_items")
    .select("id, source_url")
    .eq("source_id", source.id)
    .eq("item_status", "blocked")
    .order("collected_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);
  const rows = blockedRows ?? [];

  let open = rows;
  if (rows.length) {
    const { data: sup, error: supError } = await supabase
      .from("raw_items")
      .select("supersedes_raw_item_id")
      .in("supersedes_raw_item_id", rows.map((r) => r.id));
    if (supError) throw new Error(supError.message);
    const done = new Set((sup ?? []).map((r) => r.supersedes_raw_item_id));
    open = rows.filter((r) => !done.has(r.id));
  }
  const targets = open.slice(0, limit);

  const jobId = await createJob(supabase, source.id, null, {
    method: "malta-retroactive",
    collector_version: COLLECTOR_VERSION,
    blocked_ids: targets.map((t) => t.id),
  });
  const counts = { fetched: targets.length, ingested: 0, duplicates: 0, failed: 0 };
  try {
    for (const row of targets) {
      const result = await collectMaltaDocument(row.source_url);
      if (!result.ok) {
        counts.failed += 1;
        continue;
      }
      const outcome = await insertCollected({
        supabase,
        source,
        url: row.source_url,
        jobId,
        result,
        supersedesId: row.id,
      });
      if (outcome === "ingested") counts.ingested += 1;
      else counts.duplicates += 1;
    }
    await finishJob(supabase, jobId, counts);
    return {
      jobId,
      found: targets.length,
      ingested: counts.ingested,
      duplicates: counts.duplicates,
      blocked: counts.failed,
      failed: counts.failed,
      remaining: Math.max(open.length - targets.length, 0),
    };
  } catch (e) {
    const message = (e as Error).message;
    await finishJob(supabase, jobId, counts, message);
    throw new Error(message);
  }
}
