/**
 * collect-nl-overheid — scheduled Dutch official-publication collection.
 *
 * repository.overheid.nl exposes an open SRU 2.0 search service (no key):
 *   https://repository.overheid.nl/sru?operation=searchRetrieve&version=2.0&query=<cql>
 * It covers the Staatscourant, official announcements and parliamentary papers,
 * supports real keyword search, an exact publication-date bound and paging.
 * Full text of each record is available as XML from zoek.officielebekendmakingen.nl.
 *
 * Boundaries: writes ONLY to collection_jobs / raw_items / normalized_items.
 * raw_items are immutable and deduplicated by SHA-256. Everything stays
 * unreviewed / internal_only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

const SRU_BASE = "https://repository.overheid.nl/sru";
const TEXT_BASE = "https://zoek.officielebekendmakingen.nl";

export const NL_COLLECTOR_VERSION = "nl-overheid-scheduled@1.0.0";
export const SOURCE_DOMAIN = "overheid.nl";
export const WINDOW_DAYS = 7;
export const MAX_PAGES_PER_TERM = 5;
export const MAX_DOCS_PER_TERM = 100;
const PAGE_SIZE = 20;

/** Nautical / recreational navigation terms — deliberately scoped. */
export const NL_TERMS = [
  "pleziervaart",
  "pleziervaartuig",
  "recreatievaart",
  "vaarbewijs",
  "jachthaven",
  "ligplaats",
  "waterscooter",
  "snelle motorboot",
  "binnenvaartpolitiereglement",
];

function log(step: string, detail?: unknown) {
  if (detail === undefined) console.log(`[collect-nl-overheid] ${step}`);
  else console.log(`[collect-nl-overheid] ${step}`, JSON.stringify(detail));
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

function tagValue(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
  return match?.[1] ? decodeEntities(match[1].trim()) : null;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ----------------------------------------------------------------- SRU search

export type NlRecord = {
  identifier: string;
  title: string | null;
  abstract: string | null;
  available: Date | null;
  creator: string | null;
  type: string | null;
  url: string;
};

function parseRecords(xml: string): { records: NlRecord[]; total: number } {
  const total = Number(tagValue(xml, "sru:numberOfRecords") ?? "0");
  const records: NlRecord[] = [];
  for (const match of xml.matchAll(/<sru:record>([\s\S]*?)<\/sru:record>/g)) {
    const block = match[1] ?? "";
    const identifier = tagValue(block, "dcterms:identifier");
    if (!identifier) continue;
    const availableRaw =
      tagValue(block, "dcterms:available") ??
      tagValue(block, "dcterms:issued") ??
      tagValue(block, "dcterms:date");
    const available = availableRaw ? new Date(`${availableRaw}T00:00:00Z`) : null;
    records.push({
      identifier,
      title: tagValue(block, "dcterms:title"),
      abstract: tagValue(block, "dcterms:abstract"),
      available: available && !Number.isNaN(available.getTime()) ? available : null,
      creator: tagValue(block, "dcterms:creator"),
      type: tagValue(block, "dcterms:type"),
      url: `${TEXT_BASE}/${identifier}.html`,
    });
  }
  return { records, total };
}

async function searchNlPage(input: {
  term: string;
  since: Date;
  until: Date;
  startRecord: number;
}): Promise<{ records: NlRecord[]; total: number }> {
  const cql = [
    `cql.textAndIndexes="${input.term}"`,
    `dt.available>="${isoDay(input.since)}"`,
    `dt.available<="${isoDay(input.until)}"`,
  ].join(" and ");

  const url = new URL(SRU_BASE);
  url.searchParams.set("operation", "searchRetrieve");
  url.searchParams.set("version", "2.0");
  url.searchParams.set("query", cql);
  url.searchParams.set("maximumRecords", String(PAGE_SIZE));
  url.searchParams.set("startRecord", String(input.startRecord));

  const response = await fetch(url, {
    headers: { Accept: "application/xml", "User-Agent": "OryxScrape/1.0" },
  });
  const xml = await response.text();
  if (!response.ok) {
    throw new Error(`overheid.nl SRU failed [${response.status}]: ${xml.slice(0, 300)}`);
  }
  if (xml.includes("<diag:diagnostic")) {
    const detail = tagValue(xml, "diag:message") ?? tagValue(xml, "diag:details") ?? "unknown";
    throw new Error(`overheid.nl SRU diagnostic: ${detail}`);
  }
  return parseRecords(xml);
}

/**
 * Full text. Not every publication is served as XML (older or scanned items
 * answer 404 there), so we fall back to the HTML rendition before giving up.
 */
async function fetchNlText(identifier: string): Promise<{ xml: string; plain: string }> {
  const id = encodeURIComponent(identifier);
  const attempts: { url: string; accept: string }[] = [
    { url: `${TEXT_BASE}/${id}.xml`, accept: "application/xml" },
    { url: `${TEXT_BASE}/${id}.html`, accept: "text/html" },
  ];

  let lastError = "";
  for (const attempt of attempts) {
    const response = await fetch(attempt.url, {
      headers: { Accept: attempt.accept, "User-Agent": "OryxScrape/1.0" },
    });
    const body = await response.text();
    if (!response.ok) {
      lastError = `[${response.status}] ${attempt.url}`;
      continue;
    }
    const plain = stripTags(body);
    if (!plain.trim()) {
      lastError = `empty body at ${attempt.url}`;
      continue;
    }
    return { xml: body, plain };
  }
  throw new Error(`overheid.nl text failed: ${lastError}`);
}

// ------------------------------------------------------------------- runner

export type NlPassStats = {
  term: string;
  pages: number;
  hits: number;
  ingested: number;
  duplicates: number;
  failed: number;
  stopped_by: "exhausted" | "ceiling";
};

export async function runNlOverheidCollection(supabase: SupabaseClient<Database>) {
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
  log("date window", { since: isoDay(since), until: isoDay(until) });

  const { data: job, error: jobError } = await supabase
    .from("collection_jobs")
    .insert({
      source_id: source.id,
      profile_id: null,
      status: "running",
      started_at: new Date().toISOString(),
      run_params: {
        function: "collect-nl-overheid",
        job_type: "scheduled",
        api: "repository.overheid.nl-sru",
        collector_version: NL_COLLECTOR_VERSION,
        window_start: since.toISOString(),
        window_end: until.toISOString(),
        window_days: WINDOW_DAYS,
        max_pages_per_term: MAX_PAGES_PER_TERM,
        max_docs_per_term: MAX_DOCS_PER_TERM,
        terms: NL_TERMS,
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
    const perTerm: NlPassStats[] = [];
    const seenThisRun = new Set<string>();

    for (const term of NL_TERMS) {
      const stats: NlPassStats = {
        term,
        pages: 0,
        hits: 0,
        ingested: 0,
        duplicates: 0,
        failed: 0,
        stopped_by: "exhausted",
      };
      let docsThisTerm = 0;

      pageLoop: for (let page = 1; page <= MAX_PAGES_PER_TERM; page += 1) {
        const { records } = await searchNlPage({
          term,
          since,
          until,
          startRecord: (page - 1) * PAGE_SIZE + 1,
        });
        stats.pages = page;
        if (!records.length) break;

        for (const record of records) {
          if (docsThisTerm >= MAX_DOCS_PER_TERM) {
            stats.stopped_by = "ceiling";
            break pageLoop;
          }
          docsThisTerm += 1;
          stats.hits += 1;
          fetched += 1;

          if (seenThisRun.has(record.identifier)) {
            stats.duplicates += 1;
            duplicates += 1;
            continue;
          }
          seenThisRun.add(record.identifier);

          try {
            const { xml, plain } = await fetchNlText(record.identifier);
            if (!plain.trim()) {
              log("empty document skipped", { id: record.identifier });
              stats.failed += 1;
              failed += 1;
              continue;
            }

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
                source_url: record.url,
                raw_payload: {
                  record: {
                    identifier: record.identifier,
                    title: record.title,
                    abstract: record.abstract,
                    available: record.available?.toISOString() ?? null,
                    creator: record.creator,
                    type: record.type,
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
                canonical_url: record.url,
                http_status: 200,
                content_type: "application/xml",
                language: "nl",
                apify_actor_id: null,
                apify_run_id: null,
                collector_version: NL_COLLECTOR_VERSION,
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
              source_url: record.url,
              jurisdiction_hint: "NL",
              category: "nautical_sweep",
              payload: {
                title: record.title,
                text_content: plain,
                url: record.url,
                doc_type: record.type,
                identificador: record.identifier,
                departamento: record.creator,
                published_at: record.available?.toISOString() ?? null,
                language: "nl",
                tags: ["nautical_sweep"],
                search_term: term,
                collector_version: NL_COLLECTOR_VERSION,
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
              `[collect-nl-overheid] document failed ${record.identifier}: ${(error as Error).message}`,
            );
            stats.failed += 1;
            failed += 1;
          }
        }

        if (records.length < PAGE_SIZE) break;
        if (page === MAX_PAGES_PER_TERM) stats.stopped_by = "ceiling";
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
    console.error(`[collect-nl-overheid] run failed: ${message}`);
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
