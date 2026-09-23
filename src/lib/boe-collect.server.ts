/**
 * collect-es-boe — scheduled Spanish legislation collection (server-only).
 *
 * Collects recent Spanish legislation from the BOE open data API
 * (legislación consolidada), bounded by publication date.
 *
 * Boundaries:
 *  - Writes ONLY to the OryxScrape schema (collection_jobs, raw_items,
 *    normalized_items). Never to any consumer database.
 *  - raw_items are immutable: insert only, deduplicated by SHA-256 content hash.
 *  - Everything collected stays unreviewed / internal_only. No promotion,
 *    no publication, no handoff.
 *
 * The BOE API is fully open: plain GET over https, no token, no registration.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

const API_BASE = "https://boe.es/datosabiertos/api/legislacion-consolidada";

export const BOE_COLLECTOR_VERSION = "boe-scheduled@1.0.0";

export const SOURCE_DOMAIN = "boe.es";
export const WINDOW_DAYS = 7;
export const MAX_PAGES_PER_TERM = 5;
export const MAX_DOCS_PER_TERM = 100;
const PAGE_SIZE = 20;

/** Nautical / recreational navigation terms — deliberately scoped. */
export const BOE_TERMS = [
  "embarcaciones de recreo",
  "navegación de recreo",
  "título náutico",
  "licencia de navegación",
  "puertos deportivos",
  "amarre",
  "despacho de embarcaciones",
  "motos náuticas",
  "seguro de embarcaciones",
];

function log(step: string, detail?: unknown) {
  if (detail === undefined) console.log(`[collect-es-boe] ${step}`);
  else console.log(`[collect-es-boe] ${step}`, JSON.stringify(detail));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** BOE dates are compact ISO 8601: AAAAMMDD. */
function boeDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

/** AAAAMMDD -> Date (UTC midnight), or null. */
function fromBoeDate(raw: string | null | undefined): Date | null {
  if (!raw || !/^\d{8}/.test(raw)) return null;
  const value = new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`);
  return Number.isNaN(value.getTime()) ? null : value;
}

// ------------------------------------------------------------------ BOE API

export type BoeHit = {
  identificador: string;
  titulo?: string;
  fecha_publicacion?: string;
  fecha_disposicion?: string;
  fecha_actualizacion?: string;
  url_eli?: string;
  url_html_consolidada?: string;
  rango?: { codigo?: string; texto?: string };
  departamento?: { codigo?: string; texto?: string };
  ambito?: { codigo?: string; texto?: string };
  numero_oficial?: string;
  diario_numero?: string;
};

/**
 * One page of a publication-date-bounded consolidated-legislation search.
 *
 * Note on the date bound: the endpoint's top-level `from`/`to` parameters filter
 * by LAST UPDATE date, which would re-surface every old law that was merely
 * amended. The publication-date bound therefore goes in the `range` block, so
 * this is publication date, not version date.
 */
async function searchBoePage(input: {
  term: string;
  since: Date;
  until: Date;
  offset: number;
}): Promise<BoeHit[]> {
  const query = {
    query: {
      query_string: { query: `texto:"${input.term}" or titulo:"${input.term}"` },
      range: {
        fecha_publicacion: { gte: boeDate(input.since), lte: boeDate(input.until) },
      },
    },
    sort: [{ fecha_publicacion: "desc" }],
  };

  const url = new URL(API_BASE);
  url.searchParams.set("query", JSON.stringify(query));
  url.searchParams.set("offset", String(input.offset));
  url.searchParams.set("limit", String(PAGE_SIZE));

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`BOE search failed [${response.status}]: ${text.slice(0, 300)}`);
  }

  const payload = JSON.parse(text) as {
    status?: { code?: string; text?: string };
    data?: BoeHit[] | null;
  };
  if (payload.status?.code && payload.status.code !== "200") {
    throw new Error(`BOE search error: ${payload.status.text ?? payload.status.code}`);
  }
  return Array.isArray(payload.data) ? payload.data : [];
}

function stripTags(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/** Consolidated full text of one norm. The /texto endpoint only answers XML. */
async function fetchBoeText(identificador: string): Promise<{ xml: string; plain: string }> {
  const response = await fetch(`${API_BASE}/id/${encodeURIComponent(identificador)}/texto`, {
    headers: { Accept: "application/xml" },
  });
  const xml = await response.text();
  if (!response.ok) {
    throw new Error(`BOE texto failed [${response.status}]: ${xml.slice(0, 300)}`);
  }
  return { xml, plain: stripTags(xml) };
}

function boeUrl(hit: BoeHit): string {
  return (
    hit.url_eli ??
    hit.url_html_consolidada ??
    `https://www.boe.es/buscar/act.php?id=${hit.identificador}`
  );
}

// ------------------------------------------------------------------- runner

export type BoePassStats = {
  term: string;
  pages: number;
  hits: number;
  ingested: number;
  duplicates: number;
  failed: number;
  out_of_window: number;
  stopped_by: "exhausted" | "date_window" | "ceiling";
};

export async function runBoeCollection(supabase: SupabaseClient<Database>) {
  log("run started");

  // 1. Source
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

  // 2. Rolling 7-day publication window
  const until = new Date();
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  log("date window", { since: boeDate(since), until: boeDate(until) });

  // 3. Job row
  const { data: job, error: jobError } = await supabase
    .from("collection_jobs")
    .insert({
      source_id: source.id,
      profile_id: null,
      status: "running",
      started_at: new Date().toISOString(),
      run_params: {
        function: "collect-es-boe",
        job_type: "scheduled",
        api: "boe-legislacion-consolidada",
        collector_version: BOE_COLLECTOR_VERSION,
        window_start: since.toISOString(),
        window_end: until.toISOString(),
        window_days: WINDOW_DAYS,
        max_pages_per_term: MAX_PAGES_PER_TERM,
        max_docs_per_term: MAX_DOCS_PER_TERM,
        terms: BOE_TERMS,
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
    const perTerm: BoePassStats[] = [];
    const seenThisRun = new Set<string>();

    for (const term of BOE_TERMS) {
      const stats: BoePassStats = {
        term,
        pages: 0,
        hits: 0,
        ingested: 0,
        duplicates: 0,
        failed: 0,
        out_of_window: 0,
        stopped_by: "exhausted",
      };

      let page = 1;
      let docsThisTerm = 0;

      pageLoop: while (page <= MAX_PAGES_PER_TERM && docsThisTerm < MAX_DOCS_PER_TERM) {
        const hits = await searchBoePage({
          term,
          since,
          until,
          offset: (page - 1) * PAGE_SIZE,
        });
        stats.pages = page;
        if (!hits.length) break;

        for (const hit of hits) {
          if (docsThisTerm >= MAX_DOCS_PER_TERM) {
            stats.stopped_by = "ceiling";
            break pageLoop;
          }

          const published = fromBoeDate(hit.fecha_publicacion);
          if (published && published < since) {
            // Newest-first: everything beyond this point is older.
            stats.out_of_window += 1;
            stats.stopped_by = "date_window";
            break pageLoop;
          }

          docsThisTerm += 1;
          stats.hits += 1;
          fetched += 1;

          if (seenThisRun.has(hit.identificador)) {
            stats.duplicates += 1;
            duplicates += 1;
            continue;
          }
          seenThisRun.add(hit.identificador);

          try {
            const { xml, plain } = await fetchBoeText(hit.identificador);
            if (!plain.trim()) {
              log("empty document skipped", { id: hit.identificador });
              stats.failed += 1;
              failed += 1;
              continue;
            }

            const url = boeUrl(hit);
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
                  hit,
                  texto_xml: xml,
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
                canonical_url: url,
                http_status: 200,
                content_type: "application/xml",
                language: "es",
                apify_actor_id: null,
                apify_run_id: null,
                collector_version: BOE_COLLECTOR_VERSION,
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
              jurisdiction_hint: "ES",
              category: "nautical_sweep",
              payload: {
                title: hit.titulo ?? null,
                text_content: plain,
                url,
                doc_type: hit.rango?.texto ?? null,
                identificador: hit.identificador,
                numero_oficial: hit.numero_oficial ?? null,
                departamento: hit.departamento?.texto ?? null,
                published_at: published ? published.toISOString() : null,
                language: "es",
                tags: ["nautical_sweep"],
                search_term: term,
                collector_version: BOE_COLLECTOR_VERSION,
              } as unknown as never,
              is_official_domain: source.is_official_domain,
              is_primary_document: source.is_primary_document,
              traceability_level: source.traceability_level,
              institution_class: source.institution_class,
              collected_at: collectedAt,
              // Stays unreviewed / internal-only until a human acts on it.
              verification_status: "unreviewed",
              publication_status: "internal_only",
            });
            if (normError) throw new Error(`normalized_items insert failed: ${normError.message}`);

            stats.ingested += 1;
            ingested += 1;
          } catch (error) {
            console.error(
              `[collect-es-boe] document failed ${hit.identificador}: ${(error as Error).message}`,
            );
            stats.failed += 1;
            failed += 1;
          }
        }

        if (hits.length < PAGE_SIZE) break;
        page += 1;
        if (page > MAX_PAGES_PER_TERM) stats.stopped_by = "ceiling";
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
    console.error(`[collect-es-boe] run failed: ${message}`);
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
