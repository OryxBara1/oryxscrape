/**
 * EUR-Lex / CELLAR collector (server-only).
 *
 * Searches EU nautical/maritime legislation via the open CELLAR SPARQL
 * endpoint (no key, no auth). Both filters are ANDed: the CELEX number must
 * be legislative (L = Directives, R = Regulations) AND the work must carry at
 * least one nautical EuroVoc descriptor — this keeps aviation/road documents
 * that merely mention "navigation" out.
 *
 * No full-text fetch: the eur-lex.europa.eu rendition sits behind an AWS WAF
 * JS challenge for server-side clients, so raw_payload stores the document
 * metadata (CELEX, title, date) and the canonical human-readable URL. Dedup
 * is SHA-256 of the CELEX number — a CELEX identifies one act forever.
 *
 * Automates the collection step only: every item lands unreviewed /
 * internal_only until a human acts on it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

export const EU_COLLECTOR_VERSION = "eu-eurlex-scheduled@1.1.0";
export const SOURCE_DOMAIN = "eur-lex.europa.eu";

const SPARQL_ENDPOINT = "https://publications.europa.eu/webapi/rdf/sparql";
const EULEX_TEXT_BASE = "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:";

const WINDOW_DAYS = 7;
const FIRST_RUN_WINDOW_DAYS = 365;
const MAX_PAGES = 5;
const PAGE_SIZE = 100;

/** EuroVoc descriptors: waterway transport, pleasure craft, maritime safety, sea transport. */
const EUROVOC_CONCEPTS = [
  "http://eurovoc.europa.eu/3193",
  "http://eurovoc.europa.eu/4790",
  "http://eurovoc.europa.eu/5551",
  "http://eurovoc.europa.eu/1499",
];

export type CollectionResult = {
  jobId: string;
  found: number;
  new_items: number;
  duplicates: number;
  failures: number;
};

type EuRecord = {
  work: string;
  celex: string;
  title: string | null;
  date: string | null;
  url: string;
};

type SparqlBinding = {
  work?: { value: string };
  celexNumber?: { value: string };
  title?: { value: string };
  date?: { value: string };
};

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildQuery(since: Date, until: Date, offset: number): string {
  const values = EUROVOC_CONCEPTS.map((uri) => `<${uri}>`).join(" ");
  return `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX dc: <http://purl.org/dc/elements/1.1/>

SELECT DISTINCT ?work ?celexNumber ?title ?date WHERE {
  ?work cdm:work_date_document ?date .
  ?work cdm:resource_legal_id_celex ?celexNumber .

  # CONDITION 1 (required): CELEX legislative prefix (L = Directives, R = Regulations)
  FILTER(STRSTARTS(STR(?celexNumber), "3") || REGEX(?celexNumber, "^[LR]"))

  # CONDITION 2 (required): at least one nautical EuroVoc descriptor — AND with condition 1
  ?work cdm:work_is_about_concept_eurovoc ?concept .
  VALUES ?concept { ${values} }

  # Title in English (canonical language)
  OPTIONAL {
    ?work cdm:work_title ?title .
    FILTER(LANG(?title) = "en")
  }

  FILTER(?date >= "${isoDay(since)}"^^<http://www.w3.org/2001/XMLSchema#date>)
  FILTER(?date <= "${isoDay(until)}"^^<http://www.w3.org/2001/XMLSchema#date>)
}
ORDER BY DESC(?date)
LIMIT ${PAGE_SIZE}
OFFSET ${offset}`;
}

async function searchEuPage(since: Date, until: Date, offset: number): Promise<EuRecord[]> {
  const response = await fetch(
    `${SPARQL_ENDPOINT}?query=${encodeURIComponent(buildQuery(since, until, offset))}`,
    { headers: { Accept: "application/sparql-results+json", "User-Agent": "OryxScrape/1.0" } },
  );
  if (!response.ok) {
    throw new Error(`CELLAR SPARQL failed [${response.status}]: ${(await response.text()).slice(0, 200)}`);
  }
  const json = (await response.json()) as { results?: { bindings?: SparqlBinding[] } };
  const records: EuRecord[] = [];
  for (const binding of json.results?.bindings ?? []) {
    const work = binding.work?.value;
    const celex = binding.celexNumber?.value;
    if (!work || !celex) continue;
    records.push({
      work,
      celex,
      title: binding.title?.value ?? null,
      date: binding.date?.value ?? null,
      url: `${EULEX_TEXT_BASE}${encodeURIComponent(celex)}`,
    });
  }
  return records;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function ensureSource(supabase: SupabaseClient<Database>): Promise<string> {
  const { data: existing } = await supabase
    .from("sources")
    .select("id")
    .eq("domain", SOURCE_DOMAIN)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: inserted, error } = await supabase
    .from("sources")
    .insert({
      name: "EUR-Lex (EU legislation)",
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
      schedule_enabled: true,
      schedule_notes: "/api/public/cron/collect-eu-eurlex — daily recommended",
    })
    .select("id")
    .single();
  if (error) throw new Error(`sources insert failed: ${error.message}`);
  return inserted.id;
}

export async function runEurlexCollection(
  supabase: SupabaseClient<Database>,
): Promise<CollectionResult> {
  const sourceId = await ensureSource(supabase);

  // Date window: first run (no previous items for this source) backfills
  // 365 days so in-force directives are captured; later runs use 7 days.
  // NOTE: the DB enum collection_method has no 'sparql' value — EUR-Lex rows
  // are stored with 'api' like the other API collectors.
  const { count } = await supabase
    .from("raw_items")
    .select("id", { count: "exact", head: true })
    .eq("source_id", sourceId);
  const firstRun = (count ?? 0) === 0;
  const windowDays = firstRun ? FIRST_RUN_WINDOW_DAYS : WINDOW_DAYS;

  const until = new Date();
  const since = new Date(until.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const { data: job, error: jobError } = await supabase
    .from("collection_jobs")
    .insert({
      source_id: sourceId,
      profile_id: null,
      status: "running",
      started_at: new Date().toISOString(),
      run_params: {
        function: "collect-eu-eurlex",
        job_type: "scheduled",
        api: "cellar-sparql",
        collector_version: EU_COLLECTOR_VERSION,
        window_start: isoDay(since),
        window_end: isoDay(until),
        window_days: windowDays,
        first_run: firstRun,
        max_pages: MAX_PAGES,
        eurovoc_concepts: EUROVOC_CONCEPTS,
      },
    })
    .select("id")
    .single();
  if (jobError) throw new Error(`collection_jobs insert failed: ${jobError.message}`);
  const jobId = job.id;

  let found = 0;
  let newItems = 0;
  let duplicates = 0;
  let failures = 0;

  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const records = await searchEuPage(since, until, page * PAGE_SIZE);
      if (records.length === 0) break;
      found += records.length;

      for (const record of records) {
        try {
          const contentHash = await sha256Hex(record.celex);

          const { data: existing } = await supabase
            .from("raw_items")
            .select("id")
            .eq("source_id", sourceId)
            .eq("content_hash", contentHash)
            .maybeSingle();
          if (existing) {
            duplicates += 1;
            continue;
          }

          const title = record.title?.trim() || record.celex;

          const { data: raw, error: rawError } = await supabase
            .from("raw_items")
            .insert({
              job_id: jobId,
              source_id: sourceId,
              source_url: record.url,
              raw_payload: {
                celexNumber: record.celex,
                title: record.title,
                date: record.date,
                cellar_work: record.work,
              },
              content_hash: contentHash,
              collected_at: new Date().toISOString(),
              collection_method: "api",
              is_official_domain: true,
              is_primary_document: true,
              traceability_level: "direct_url",
              institution_class: "intergovernmental",
              canonical_url: record.url,
              http_status: 200,
              content_type: "application/sparql-results+json",
              language: "en",
              collector_version: EU_COLLECTOR_VERSION,
            })
            .select("id")
            .single();
          if (rawError) {
            if (rawError.code === "23505") duplicates += 1;
            else {
              failures += 1;
              console.error("[eu-eurlex] raw insert failed", record.celex, rawError.message);
            }
            continue;
          }

          const { error: normError } = await supabase.from("normalized_items").insert({
            raw_item_id: raw.id,
            source_id: sourceId,
            source_url: record.url,
            // jurisdiction_hint = "EU" marks this as supranational (not a single-country ISO2).
            // Consumer apps (e.g. Auramaris) are responsible for mapping EU directives
            // to the specific member states they cover.
            // Future: scope_hint = "supranational"
            jurisdiction_hint: "EU",
            category: "nautical_sweep",
            payload: {
              title,
              url: record.url,
              doc_type: "regulation",
              tier: "official",
              trust_tier: "official",
              celexNumber: record.celex,
              cellar_work: record.work,
              published_at: record.date,
              language: "en",
              collector_version: EU_COLLECTOR_VERSION,
            },
            is_official_domain: true,
            is_primary_document: true,
            traceability_level: "direct_url",
            institution_class: "intergovernmental",
            collected_at: new Date().toISOString(),
            verification_status: "unreviewed",
            publication_status: "internal_only",
            tags: ["maritime", "eu-legislation", "eurlex"],
          });
          if (normError) {
            failures += 1;
            console.error("[eu-eurlex] normalized insert failed", record.celex, normError.message);
            continue;
          }
          newItems += 1;
        } catch (error) {
          failures += 1;
          console.error("[eu-eurlex] item failed", record.celex, (error as Error).message);
        }
      }

      if (records.length < PAGE_SIZE) break;
    }

    await supabase
      .from("collection_jobs")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        fetched_count: found,
        new_count: newItems,
        duplicate_count: duplicates,
        failed_count: failures,
      })
      .eq("id", jobId);

    return { jobId, found, new_items: newItems, duplicates, failures };
  } catch (error) {
    const message = (error as Error).message;
    await supabase
      .from("collection_jobs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error_text: message })
      .eq("id", jobId);
    throw new Error(message);
  }
}
