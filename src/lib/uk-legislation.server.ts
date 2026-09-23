/**
 * collect-uk-legislation — scheduled UK legislation collection (server-only).
 *
 * legislation.gov.uk exposes an open Atom search feed (no key, no account):
 *   https://www.legislation.gov.uk/all/{year}/data.feed?text={term}&page={n}
 * Each entry links to the full legal text as XML.
 *
 * Quirk verified live: `start-date` / `end-date` query parameters are silently
 * ignored by the feed — only the year in the PATH filters. The 7-day rolling
 * publication window is therefore applied by us, after reading each entry's
 * publication date.
 *
 * Boundaries: writes ONLY to collection_jobs / raw_items / normalized_items.
 * raw_items are immutable and deduplicated by SHA-256. Everything stays
 * unreviewed / internal_only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

const FEED_BASE = "https://www.legislation.gov.uk";

export const UK_COLLECTOR_VERSION = "uk-legislation-scheduled@1.0.0";
export const SOURCE_DOMAIN = "legislation.gov.uk";
export const WINDOW_DAYS = 7;
export const MAX_PAGES_PER_TERM = 5;
export const MAX_DOCS_PER_TERM = 100;

/** Nautical / recreational navigation terms — deliberately scoped. */
export const UK_TERMS = [
  "recreational craft",
  "pleasure vessel",
  "pleasure craft",
  "small craft",
  "personal watercraft",
  "marina",
  "mooring",
  "boat safety",
  "yacht",
];

function log(step: string, detail?: unknown) {
  if (detail === undefined) console.log(`[collect-uk-legislation] ${step}`);
  else console.log(`[collect-uk-legislation] ${step}`, JSON.stringify(detail));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

function stripTags(xml: string): string {
  return decodeEntities(xml.replace(/<[^>]+>/g, "\n"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function firstMatch(block: string, pattern: RegExp): string | null {
  const match = pattern.exec(block);
  return match?.[1] ? decodeEntities(match[1].trim()) : null;
}

// --------------------------------------------------------------- Atom search

export type UkEntry = {
  id: string;
  title: string | null;
  published: Date | null;
  updated: Date | null;
  htmlUrl: string | null;
  xmlUrl: string | null;
  docType: string | null;
  year: string | null;
  number: string | null;
};

function parseEntries(atom: string): UkEntry[] {
  const entries: UkEntry[] = [];
  for (const match of atom.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = match[1] ?? "";
    const id = firstMatch(block, /<id>([^<]+)<\/id>/);
    if (!id) continue;

    const publishedRaw = firstMatch(block, /<published>([^<]+)<\/published>/);
    const updatedRaw = firstMatch(block, /<updated>([^<]+)<\/updated>/);
    const xmlUrl = firstMatch(
      block,
      /<link[^>]*type="application\/xml"[^>]*href="([^"]+)"/,
    );
    const htmlUrl = firstMatch(
      block,
      /<link[^>]*rel="alternate"[^>]*type="text\/html"[^>]*href="([^"]+)"/,
    );

    // http://www.legislation.gov.uk/id/uksi/2026/577
    const idParts = /\/id\/([a-z]+)\/(\d{4})\/([^/]+)$/.exec(id);

    const toDate = (raw: string | null) => {
      if (!raw) return null;
      const value = new Date(raw);
      return Number.isNaN(value.getTime()) ? null : value;
    };

    entries.push({
      id,
      title: firstMatch(block, /<title[^>]*>([\s\S]*?)<\/title>/),
      published: toDate(publishedRaw),
      updated: toDate(updatedRaw),
      htmlUrl: htmlUrl ?? id.replace("/id/", "/"),
      xmlUrl,
      docType: idParts?.[1] ?? null,
      year: idParts?.[2] ?? null,
      number: idParts?.[3] ?? null,
    });
  }
  return entries;
}

async function searchUkPage(input: {
  term: string;
  year: number;
  page: number;
}): Promise<UkEntry[]> {
  const url = new URL(`${FEED_BASE}/all/${input.year}/data.feed`);
  url.searchParams.set("text", input.term);
  url.searchParams.set("page", String(input.page));

  const response = await fetch(url, {
    headers: { Accept: "application/atom+xml", "User-Agent": "OryxScrape/1.0" },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`legislation.gov.uk search failed [${response.status}]: ${text.slice(0, 300)}`);
  }
  return parseEntries(text);
}

async function fetchUkText(entry: UkEntry): Promise<{ xml: string; plain: string; url: string }> {
  const target = entry.xmlUrl ?? `${entry.id.replace("/id/", "/")}/data.xml`;
  const response = await fetch(target, {
    headers: { Accept: "application/xml", "User-Agent": "OryxScrape/1.0" },
  });
  const xml = await response.text();
  if (!response.ok) {
    throw new Error(`legislation.gov.uk text failed [${response.status}]: ${xml.slice(0, 300)}`);
  }
  return { xml, plain: stripTags(xml), url: target };
}

// ------------------------------------------------------------------- runner

export type UkPassStats = {
  term: string;
  pages: number;
  hits: number;
  ingested: number;
  duplicates: number;
  failed: number;
  out_of_window: number;
  stopped_by: "exhausted" | "ceiling";
};

export async function runUkLegislationCollection(supabase: SupabaseClient<Database>) {
  log("run started");

  const { data: source, error: sourceError } = await supabase
    .from("sources")
    .select(
      "id, name, domain, is_official_domain, is_primary_document, traceability_level, institution_class",
    )
    .eq("domain", SOURCE_DOMAIN)
    .eq("is_active", true)
    .maybeSingle();
  if (sourceError) throw new Error(`Source lookup failed: ${sourceError.message}`);
  if (!source) throw new Error(`No active source found for domain ${SOURCE_DOMAIN}`);
  log("source resolved", { id: source.id, name: source.name });

  const until = new Date();
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  // Only the year in the path filters, so a window crossing New Year needs both.
  const years = Array.from(
    new Set([since.getUTCFullYear(), until.getUTCFullYear()]),
  ).sort();
  log("date window", { since: since.toISOString(), until: until.toISOString(), years });

  const { data: job, error: jobError } = await supabase
    .from("collection_jobs")
    .insert({
      source_id: source.id,
      profile_id: null,
      status: "running",
      started_at: new Date().toISOString(),
      run_params: {
        function: "collect-uk-legislation",
        job_type: "scheduled",
        api: "legislation.gov.uk-atom",
        collector_version: UK_COLLECTOR_VERSION,
        window_start: since.toISOString(),
        window_end: until.toISOString(),
        window_days: WINDOW_DAYS,
        years,
        max_pages_per_term: MAX_PAGES_PER_TERM,
        max_docs_per_term: MAX_DOCS_PER_TERM,
        terms: UK_TERMS,
      } as unknown as never,
    })
    .select("id")
    .single();
  if (jobError) throw new Error(`Job insert failed: ${jobError.message}`);
  const jobId = job.id;
  log("job created", { jobId });

  try {
    let fetched = 0;
    let ingested = 0;
    let duplicates = 0;
    let failed = 0;
    const perTerm: UkPassStats[] = [];
    const seenThisRun = new Set<string>();

    for (const term of UK_TERMS) {
      const stats: UkPassStats = {
        term,
        pages: 0,
        hits: 0,
        ingested: 0,
        duplicates: 0,
        failed: 0,
        out_of_window: 0,
        stopped_by: "exhausted",
      };
      let docsThisTerm = 0;

      termLoop: for (const year of years) {
        for (let page = 1; page <= MAX_PAGES_PER_TERM; page += 1) {
          const entries = await searchUkPage({ term, year, page });
          stats.pages += 1;
          if (!entries.length) break;

          for (const entry of entries) {
            if (docsThisTerm >= MAX_DOCS_PER_TERM) {
              stats.stopped_by = "ceiling";
              break termLoop;
            }

            // The feed is not date-sorted, so filter rather than break.
            const published = entry.published ?? entry.updated;
            if (!published || published < since || published > until) {
              stats.out_of_window += 1;
              continue;
            }

            docsThisTerm += 1;
            stats.hits += 1;
            fetched += 1;

            if (seenThisRun.has(entry.id)) {
              stats.duplicates += 1;
              duplicates += 1;
              continue;
            }
            seenThisRun.add(entry.id);

            try {
              const { xml, plain } = await fetchUkText(entry);
              if (!plain.trim()) {
                log("empty document skipped", { id: entry.id });
                stats.failed += 1;
                failed += 1;
                continue;
              }

              const url = entry.htmlUrl ?? entry.id;
              const contentHash = await sha256Hex(plain);

              const { data: existing, error: existingError } = await supabase
                .from("raw_items")
                .select("id")
                .eq("source_id", source.id)
                .eq("content_hash", contentHash)
                .maybeSingle();
              if (existingError) throw new Error(existingError.message);
              if (existing) {
                stats.duplicates += 1;
                duplicates += 1;
                continue;
              }

              const collectedAt = new Date().toISOString();
              const { data: rawItem, error: rawError } = await supabase
                .from("raw_items")
                .insert({
                  job_id: jobId,
                  source_id: source.id,
                  source_url: url,
                  raw_payload: {
                    entry: {
                      id: entry.id,
                      title: entry.title,
                      published: entry.published?.toISOString() ?? null,
                      updated: entry.updated?.toISOString() ?? null,
                      doc_type: entry.docType,
                      year: entry.year,
                      number: entry.number,
                      xml_url: entry.xmlUrl,
                    },
                    document_xml: xml,
                    plain_text: plain,
                    search_term: term,
                  } as unknown as never,
                  content_hash: contentHash,
                  collected_at: collectedAt,
                  collection_method: "api",
                  is_official_domain: source.is_official_domain,
                  is_primary_document: source.is_primary_document,
                  traceability_level: source.traceability_level,
                  institution_class: source.institution_class,
                  canonical_url: entry.id,
                  http_status: 200,
                  content_type: "application/xml",
                  language: "en",
                  apify_actor_id: null,
                  apify_run_id: null,
                  collector_version: UK_COLLECTOR_VERSION,
                })
                .select("id")
                .single();
              if (rawError) {
                if (rawError.code === "23505") {
                  stats.duplicates += 1;
                  duplicates += 1;
                  continue;
                }
                throw new Error(rawError.message);
              }

              const { error: normError } = await supabase.from("normalized_items").insert({
                raw_item_id: rawItem.id,
                source_id: source.id,
                source_url: url,
                jurisdiction_hint: "GB",
                category: "nautical_sweep",
                payload: {
                  title: entry.title,
                  text_content: plain,
                  url,
                  doc_type: entry.docType,
                  identificador: entry.id,
                  numero_oficial: entry.number,
                  published_at: published.toISOString(),
                  language: "en",
                  tags: ["nautical_sweep"],
                  search_term: term,
                  collector_version: UK_COLLECTOR_VERSION,
                } as unknown as never,
                is_official_domain: source.is_official_domain,
                is_primary_document: source.is_primary_document,
                traceability_level: source.traceability_level,
                institution_class: source.institution_class,
                collected_at: collectedAt,
                verification_status: "unreviewed",
                publication_status: "internal_only",
              });
              if (normError) {
                throw new Error(`normalized_items insert failed: ${normError.message}`);
              }

              stats.ingested += 1;
              ingested += 1;
            } catch (error) {
              console.error(
                `[collect-uk-legislation] document failed ${entry.id}: ${(error as Error).message}`,
              );
              stats.failed += 1;
              failed += 1;
            }
          }

          if (page === MAX_PAGES_PER_TERM) stats.stopped_by = "ceiling";
        }
      }

      log("term finished", stats);
      perTerm.push(stats);
    }

    const { error: closeError } = await supabase
      .from("collection_jobs")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        fetched_count: fetched,
        new_count: ingested,
        duplicate_count: duplicates,
        failed_count: failed,
      })
      .eq("id", jobId);
    if (closeError) throw new Error(`Job close failed: ${closeError.message}`);

    log("run succeeded", { jobId, fetched, ingested, duplicates, failed });
    return {
      jobId,
      window: { since: since.toISOString(), until: until.toISOString() },
      found: fetched,
      new_items: ingested,
      duplicates,
      failures: failed,
      terms: perTerm,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    console.error(`[collect-uk-legislation] run failed: ${message}`);
    await supabase
      .from("collection_jobs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_text: message,
      })
      .eq("id", jobId);
    throw new Error(message);
  }
}
