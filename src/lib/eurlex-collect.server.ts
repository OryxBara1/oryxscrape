/**
 * collect-eu-eurlex — scheduled EU maritime-legislation collection.
 *
 * CELLAR / EUR-Lex exposes an open SPARQL endpoint (no key, no auth):
 *   https://publications.europa.eu/webapi/rdf/sparql
 * The query is restricted to legislative CELEX numbers (L/R prefixes) AND
 * to works tagged with at least one nautical EuroVoc descriptor, so aviation
 * or road-transport acts that merely mention "navigation" are excluded.
 * Full text is fetched from the EUR-Lex HTML rendition per CELEX number.
 *
 * jurisdiction_hint is "EU" for every item — NOT a country ISO2. Consumer
 * apps (e.g. Auramaris) are responsible for mapping EU directives to the
 * specific member states they cover.
 *
 * Boundaries: writes ONLY to collection_jobs / raw_items / normalized_items.
 * raw_items are immutable and deduplicated by SHA-256. Everything stays
 * unreviewed / internal_only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

const SPARQL_ENDPOINT = "https://publications.europa.eu/webapi/rdf/sparql";
const EULEX_TEXT_BASE = "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:";

export const EU_COLLECTOR_VERSION = "eu-eurlex-scheduled@1.0.0";
export const SOURCE_DOMAIN = "eur-lex.europa.eu";
export const WINDOW_DAYS = 7;
/** First run on a source with no previous items backfills one year. */
export const FIRST_RUN_WINDOW_DAYS = 365;
export const MAX_PAGES = 5;
export const MAX_DOCS_PER_RUN = 100;
const PAGE_SIZE = 100;

/** Nautical EuroVoc descriptors (waterway transport, pleasure craft, maritime safety, sea transport). */
const EUROVOC_CONCEPTS = [
  "http://eurovoc.europa.eu/3193",
  "http://eurovoc.europa.eu/4790",
  "http://eurovoc.europa.eu/5551",
  "http://eurovoc.europa.eu/1499",
];

function log(step: string, detail?: unknown) {
  if (detail === undefined) console.log(`[collect-eu-eurlex] ${step}`);
  else console.log(`[collect-eu-eurlex] ${step}`, JSON.stringify(detail));
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

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, "\n"),
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- SPARQL search

export type EuRecord = {
  work: string;
  celex: string;
  title: string | null;
  date: Date | null;
  /** CELLAR XHTML manifestation — full text without the eur-lex WAF. */
  manif: string | null;
  url: string;
};

type SparqlBinding = {
  work?: { value: string };
  celexNumber?: { value: string };
  title?: { value: string };
  date?: { value: string };
  manif?: { value: string };
};

function buildQuery(since: Date, until: Date, offset: number): string {
  const values = EUROVOC_CONCEPTS.map((uri) => `<${uri}>`).join(" ");
  return `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT DISTINCT ?work ?celexNumber ?title ?date ?manif WHERE {
  ?work cdm:work_date_document ?date .
  ?work cdm:resource_legal_id_celex ?celexNumber .
  FILTER(STRSTARTS(STR(?celexNumber), "3") || REGEX(?celexNumber, "^[LR]"))
  ?work cdm:work_is_about_concept_eurovoc ?concept .
  VALUES ?concept { ${values} }
  OPTIONAL { ?work cdm:work_title ?title . FILTER(LANG(?title) = "en") }
  OPTIONAL {
    ?expr cdm:expression_belongs_to_work ?work .
    ?expr cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> .
    ?manif cdm:manifestation_manifests_expression ?expr .
    ?manif cdm:manifestation_type ?mtype .
    FILTER(STRENDS(STR(?mtype), "xhtml"))
  }
  FILTER(?date >= "${isoDay(since)}"^^<http://www.w3.org/2001/XMLSchema#date>)
  FILTER(?date <= "${isoDay(until)}"^^<http://www.w3.org/2001/XMLSchema#date>)
}
ORDER BY DESC(?date)
LIMIT ${PAGE_SIZE}
OFFSET ${offset}`;
}

async function searchEuPage(input: {
  since: Date;
  until: Date;
  offset: number;
}): Promise<EuRecord[]> {
  const url = new URL(SPARQL_ENDPOINT);
  url.searchParams.set("query", buildQuery(input.since, input.until, input.offset));

  const response = await fetch(url, {
    headers: { Accept: "application/sparql-results+json", "User-Agent": "OryxScrape/1.0" },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`CELLAR SPARQL failed [${response.status}]: ${body.slice(0, 300)}`);
  }

  const parsed = JSON.parse(body) as { results?: { bindings?: SparqlBinding[] } };
  const bindings = parsed.results?.bindings ?? [];
  const records: EuRecord[] = [];
  for (const binding of bindings) {
    const celex = binding.celexNumber?.value;
    const work = binding.work?.value;
    if (!celex || !work) continue;
    const dateRaw = binding.date?.value;
    const date = dateRaw ? new Date(`${dateRaw}T00:00:00Z`) : null;
    records.push({
      work,
      celex,
      title: binding.title?.value ?? null,
      date: date && !Number.isNaN(date.getTime()) ? date : null,
      manif: binding.manif?.value ?? null,
      url: `${EULEX_TEXT_BASE}${encodeURIComponent(celex)}`,
    });
  }
  return records;
}

/**
 * Full text. The eur-lex.europa.eu rendition sits behind an AWS WAF JS
 * challenge (HTTP 202) for server-side clients, so we fetch the CELLAR XHTML
 * manifestation instead — same document, no bot wall. The EUR-Lex URL stays
 * as the human-readable source_url. Suspiciously small bodies (WAF challenge
 * pages, error shells) are treated as failures, never stored.
 */
const MIN_TEXT_CHARS = 500;

async function fetchEuText(record: EuRecord): Promise<{ html: string; plain: string }> {
  const attempts: { url: string; accept: string }[] = [];
  if (record.manif) {
    attempts.push({ url: record.manif, accept: "application/xhtml+xml" });
  }
  attempts.push({ url: record.url, accept: "text/html" });

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
    if (plain.length < MIN_TEXT_CHARS) {
      lastError = `body too small (${plain.length} chars) at ${attempt.url}`;
      continue;
    }
    return { html: body, plain };
  }
  throw new Error(`eur-lex text failed: ${lastError}`);
}

// ------------------------------------------------------------------- runner

export async function runEurlexCollection(supabase: SupabaseClient<Database>) {
  log("run started");

  let { data: source, error: sourceError } = await supabase
    .from("sources")
    .select(
      "id, name, domain, is_official_domain, is_primary_document, traceability_level, institution_class",
    )
    .eq("domain", SOURCE_DOMAIN)
    .eq("is_active", true)
    .maybeSingle();
  if (sourceError) throw new Error(`Source lookup failed: ${sourceError.message}`);

  if (!source) {
    const { data: inserted, error: insertError } = await supabase
      .from("sources")
      .insert({
        name: "EUR-Lex — EU legislation (CELLAR SPARQL)",
        domain: SOURCE_DOMAIN,
        start_url: "https://eur-lex.europa.eu/",
        collection_method: "api",
        is_active: true,
        tos_status: "unknown",
        robots_status: "unknown",
        is_official_domain: true,
        is_primary_document: true,
        traceability_level: "direct_url",
        institution_class: "intergovernmental",
        crawler_type: "cheerio",
        schedule_notes: "Weekly via /api/public/cron/collect-eu-eurlex",
      })
      .select(
        "id, name, domain, is_official_domain, is_primary_document, traceability_level, institution_class",
      )
      .single();
    if (insertError) throw new Error(`Source insert failed: ${insertError.message}`);
    source = inserted;
    log("source created", { id: source.id });
  }
  log("source resolved", { id: source.id, name: source.name });

  // First-run backfill: a source with no previous raw items looks back one
  // year to capture in-force directives; afterwards the standard 7-day window.
  const { count: previousItems, error: countError } = await supabase
    .from("raw_items")
    .select("id", { count: "exact", head: true })
    .eq("source_id", source.id);
  if (countError) throw new Error(`Previous-items check failed: ${countError.message}`);
  const isFirstRun = (previousItems ?? 0) === 0;
  const windowDays = isFirstRun ? FIRST_RUN_WINDOW_DAYS : WINDOW_DAYS;

  const until = new Date();
  const since = new Date(Date.now() - windowDays * 86_400_000);
  log("date window", { since: isoDay(since), until: isoDay(until), windowDays, isFirstRun });

  const { data: job, error: jobError } = await supabase
    .from("collection_jobs")
    .insert({
      source_id: source.id,
      profile_id: null,
      status: "running",
      started_at: new Date().toISOString(),
      run_params: {
        function: "collect-eu-eurlex",
        job_type: "scheduled",
        api: "cellar-sparql",
        collector_version: EU_COLLECTOR_VERSION,
        window_start: since.toISOString(),
        window_end: until.toISOString(),
        window_days: windowDays,
        first_run: isFirstRun,
        max_pages: MAX_PAGES,
        max_docs_per_run: MAX_DOCS_PER_RUN,
        eurovoc_concepts: EUROVOC_CONCEPTS,
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
    const seenThisRun = new Set<string>();
    let stoppedBy: "exhausted" | "ceiling" = "exhausted";

    pageLoop: for (let page = 0; page < MAX_PAGES; page += 1) {
      const records = await searchEuPage({ since, until, offset: page * PAGE_SIZE });
      log("page fetched", { page: page + 1, records: records.length });
      if (!records.length) break;

      for (const record of records) {
        if (fetched >= MAX_DOCS_PER_RUN) {
          stoppedBy = "ceiling";
          break pageLoop;
        }
        fetched += 1;

        if (seenThisRun.has(record.celex)) {
          duplicates += 1;
          continue;
        }
        seenThisRun.add(record.celex);

        try {
          const { html, plain } = await fetchEuText(record.celex);
          const contentHash = await sha256Hex(plain);

          const { data: existing, error: existingError } = await supabase
            .from("raw_items")
            .select("id")
            .eq("source_id", source.id)
            .eq("content_hash", contentHash)
            .maybeSingle();
          if (existingError) throw new Error(existingError.message);
          if (existing) {
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
                  work: record.work,
                  celex: record.celex,
                  title: record.title,
                  date: record.date?.toISOString() ?? null,
                },
                document_html: html,
                plain_text: plain,
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
              content_type: "text/html",
              language: "en",
              apify_actor_id: null,
              apify_run_id: null,
              collector_version: EU_COLLECTOR_VERSION,
            })
            .select("id")
            .single();
          if (rawError) {
            if (rawError.code === "23505") {
              duplicates += 1;
              continue;
            }
            throw new Error(rawError.message);
          }

          const { error: normError } = await supabase.from("normalized_items").insert({
            raw_item_id: rawItem.id,
            source_id: source.id,
            source_url: record.url,
            // "EU" on purpose: consumer apps (e.g. Auramaris) map EU acts to
            // the member states they apply to.
            jurisdiction_hint: "EU",
            category: "nautical_sweep",
            payload: {
              title: record.title,
              text_content: plain,
              url: record.url,
              celex: record.celex,
              cellar_work: record.work,
              published_at: record.date?.toISOString() ?? null,
              language: "en",
              tags: ["nautical_sweep", "eu_legislation"],
              collector_version: EU_COLLECTOR_VERSION,
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

          ingested += 1;
        } catch (error) {
          console.error(
            `[collect-eu-eurlex] document failed ${record.celex}: ${(error as Error).message}`,
          );
          failed += 1;
        }
      }

      if (records.length < PAGE_SIZE) break;
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

    log("run succeeded", { jobId, fetched, ingested, duplicates, failed, stoppedBy });
    return {
      jobId,
      window: { since: since.toISOString(), until: until.toISOString(), days: windowDays },
      first_run: isFirstRun,
      found: fetched,
      new_items: ingested,
      duplicates,
      failures: failed,
      stopped_by: stoppedBy,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    console.error(`[collect-eu-eurlex] run failed: ${message}`);
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
