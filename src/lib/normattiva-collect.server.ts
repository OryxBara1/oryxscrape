/**
 * collect-it-normattiva — scheduled Italian legislation collection (server-only).
 *
 * Uses the Normattiva open data API (no key, no account):
 *   POST {API_BASE}/ricerca/avanzata      keyword + Gazzetta Ufficiale date search
 *   POST {API_BASE}/atto/dettaglio-atto   act detail incl. HTML text
 *
 * Boundaries (same as the France/Spain collectors):
 *  - Writes ONLY to collection_jobs, raw_items, normalized_items.
 *  - raw_items are immutable: insert only, deduplicated by SHA-256 content hash.
 *  - Everything stays unreviewed / internal_only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

const API_BASE = "https://api.normattiva.it/t/normattiva.api/bff-opendata/v1/api/v1";

export const NORMATTIVA_COLLECTOR_VERSION = "normattiva-scheduled@1.0.0";

export const SOURCE_DOMAIN = "normattiva.it";
export const WINDOW_DAYS = 7;
export const MAX_PAGES_PER_TERM = 5;
export const MAX_DOCS_PER_TERM = 100;
const PAGE_SIZE = 20;

/** Nautical / recreational navigation terms — deliberately scoped. */
export const NORMATTIVA_TERMS = [
  "natanti da diporto",
  "imbarcazioni da diporto",
  "navigazione da diporto",
  "patente nautica",
  "porto turistico",
  "ormeggio",
  "moto d'acqua",
  "sicurezza in mare",
];

function log(step: string, detail?: unknown) {
  if (detail === undefined) console.log(`[collect-it-normattiva] ${step}`);
  else console.log(`[collect-it-normattiva] ${step}`, JSON.stringify(detail));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export type NormattivaHit = {
  codiceRedazionale: string;
  dataGU: string;
  numeroGU?: string | null;
  titoloAtto?: string | null;
  descrizioneAtto?: string | null;
  denominazioneAtto?: string | null;
  numeroProvvedimento?: string | null;
  annoProvvedimento?: string | null;
  dataEmanazione?: string | null;
  [key: string]: unknown;
};

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "OryxScrape/1.0",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Normattiva ${path} failed [${response.status}]: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

async function searchPage(input: {
  term: string;
  since: Date;
  until: Date;
  page: number;
}): Promise<{ hits: NormattivaHit[]; totalPages: number }> {
  const data = await postJson<{ listaAtti?: NormattivaHit[] | null; numeroPagine?: number }>(
    "/ricerca/avanzata",
    {
      testoRicerca: input.term,
      dataInizioPubProvvedimento: isoDay(input.since),
      dataFinePubProvvedimento: isoDay(input.until),
      paginazione: { paginaCorrente: input.page, numeroElementiPerPagina: PAGE_SIZE },
    },
  );
  return { hits: data.listaAtti ?? [], totalPages: data.numeroPagine ?? 0 };
}

function stripTags(html: string): string {
  return html
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

async function fetchDetail(hit: NormattivaHit) {
  const data = await postJson<{ data?: { atto?: Record<string, unknown> } }>(
    "/atto/dettaglio-atto",
    { dataGU: hit.dataGU, codiceRedazionale: hit.codiceRedazionale },
  );
  const atto = data.data?.atto ?? {};
  const html = typeof atto["articoloHtml"] === "string" ? (atto["articoloHtml"] as string) : "";
  const header = [atto["titolo"], atto["sottoTitolo"]].filter((v) => typeof v === "string").join("\n");
  return { atto, html, plain: [header, stripTags(html)].filter(Boolean).join("\n") };
}

function actUrl(hit: NormattivaHit): string {
  return `https://www.normattiva.it/atto/caricaDettaglioAtto?atto.dataPubblicazioneGazzetta=${encodeURIComponent(
    hit.dataGU,
  )}&atto.codiceRedazionale=${encodeURIComponent(hit.codiceRedazionale)}`;
}

function cleanTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.replace(/^\[|\]$/g, "").replace(/\s+/g, " ").trim() || null;
}

export type NormattivaPassStats = {
  term: string;
  pages: number;
  hits: number;
  ingested: number;
  duplicates: number;
  failed: number;
  out_of_window: number;
  stopped_by: "exhausted" | "ceiling";
};

export async function runNormattivaCollection(supabase: SupabaseClient<Database>) {
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
  const sinceDay = isoDay(since);
  log("date window", { since: sinceDay, until: isoDay(until) });

  const { data: job, error: jobError } = await supabase
    .from("collection_jobs")
    .insert({
      source_id: source.id,
      profile_id: null,
      status: "running",
      started_at: new Date().toISOString(),
      run_params: {
        function: "collect-it-normattiva",
        job_type: "scheduled",
        api: "normattiva-bff-opendata",
        collector_version: NORMATTIVA_COLLECTOR_VERSION,
        window_start: since.toISOString(),
        window_end: until.toISOString(),
        window_days: WINDOW_DAYS,
        max_pages_per_term: MAX_PAGES_PER_TERM,
        max_docs_per_term: MAX_DOCS_PER_TERM,
        terms: NORMATTIVA_TERMS,
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
    const perTerm: NormattivaPassStats[] = [];
    const seenThisRun = new Set<string>();

    for (const term of NORMATTIVA_TERMS) {
      const stats: NormattivaPassStats = {
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

      pageLoop: while (page <= MAX_PAGES_PER_TERM) {
        const { hits, totalPages } = await searchPage({ term, since, until, page });
        stats.pages = page;
        if (!hits.length) break;

        for (const hit of hits) {
          if (docsThisTerm >= MAX_DOCS_PER_TERM) {
            stats.stopped_by = "ceiling";
            break pageLoop;
          }
          // Defensive: keep only Gazzetta publication dates inside the window.
          if (hit.dataGU && hit.dataGU < sinceDay) {
            stats.out_of_window += 1;
            continue;
          }
          docsThisTerm += 1;
          stats.hits += 1;
          fetched += 1;

          const key = `${hit.dataGU}|${hit.codiceRedazionale}`;
          if (seenThisRun.has(key)) {
            stats.duplicates += 1;
            duplicates += 1;
            continue;
          }
          seenThisRun.add(key);

          try {
            const { atto, html, plain } = await fetchDetail(hit);
            if (!html.trim()) {
              log("empty document skipped", { id: hit.codiceRedazionale });
              stats.failed += 1;
              failed += 1;
              continue;
            }
            const url = actUrl(hit);
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
                  atto,
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
                content_type: "application/json",
                language: "it",
                apify_actor_id: null,
                apify_run_id: null,
                collector_version: NORMATTIVA_COLLECTOR_VERSION,
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
              jurisdiction_hint: "IT",
              category: "nautical_sweep",
              payload: {
                title: cleanTitle(hit.titoloAtto) ?? hit.descrizioneAtto ?? null,
                text_content: plain,
                url,
                doc_type: hit.denominazioneAtto ?? null,
                identificador: hit.codiceRedazionale,
                numero_oficial: hit.descrizioneAtto ?? null,
                numero_gu: hit.numeroGU ?? null,
                published_at: hit.dataGU ? `${hit.dataGU}T00:00:00.000Z` : null,
                language: "it",
                tags: ["nautical_sweep"],
                search_term: term,
                collector_version: NORMATTIVA_COLLECTOR_VERSION,
              } as unknown as never,
              is_official_domain: source.is_official_domain,
              is_primary_document: source.is_primary_document,
              traceability_level: source.traceability_level,
              institution_class: source.institution_class,
              collected_at: collectedAt,
              verification_status: "unreviewed",
              publication_status: "internal_only",
            });
            if (normError) throw new Error(`normalized_items insert failed: ${normError.message}`);

            stats.ingested += 1;
            ingested += 1;
          } catch (error) {
            console.error(
              `[collect-it-normattiva] document failed ${hit.codiceRedazionale}: ${(error as Error).message}`,
            );
            stats.failed += 1;
            failed += 1;
          }
        }

        if (page >= totalPages || hits.length < PAGE_SIZE) break;
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
    console.error(`[collect-it-normattiva] run failed: ${message}`);
    await supabase
      .from("collection_jobs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error_text: message })
      .eq("id", jobId);
    throw new Error(message);
  }
}
