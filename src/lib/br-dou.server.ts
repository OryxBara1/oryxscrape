/**
 * collect-br-dou — scheduled Brazilian official gazette collection.
 *
 * The Diário Oficial da União search at in.gov.br accepts a keyword plus an
 * exact from/to publication date, and returns its result list as structured
 * JSON embedded inside the delivered page (script block
 * `_br_com_seatecnologia_in_buscadou_BuscaDouPortlet_params`). There is no
 * documented API: INLABS requires a gov.br login and Querido Diário's service
 * was unavailable, so we parse the official search response and keep the full
 * item page as evidence.
 *
 * Boundaries: writes ONLY to collection_jobs / raw_items / normalized_items.
 * raw_items are immutable and deduplicated by SHA-256. Everything stays
 * unreviewed / internal_only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

const SEARCH_BASE = "https://www.in.gov.br/consulta/-/buscar/dou";
const ITEM_BASE = "https://www.in.gov.br/web/dou/-";

export const BR_COLLECTOR_VERSION = "br-dou-scheduled@1.0.0";
export const SOURCE_DOMAIN = "in.gov.br";
export const WINDOW_DAYS = 7;
export const MAX_PAGES_PER_TERM = 5;
export const MAX_DOCS_PER_TERM = 100;
const PAGE_SIZE = 20;

/**
 * The gazette sits behind a CDN that answers 502 to non-browser user agents,
 * so we identify as a normal browser. Nothing else about the request changes.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** Nautical / recreational navigation terms — deliberately scoped. */
export const BR_TERMS = [
  "embarcação de esporte e recreio",
  "embarcações de recreio",
  "arrais-amador",
  "habilitação de amador",
  "inscrição de embarcação",
  "moto aquática",
  "marina",
  "atracação",
  "seguro DPEM",
];

function log(step: string, detail?: unknown) {
  if (detail === undefined) console.log(`[collect-br-dou] ${step}`);
  else console.log(`[collect-br-dou] ${step}`, JSON.stringify(detail));
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

/** DOU dates are DD-MM-YYYY on input and DD/MM/YYYY on output. */
function brDate(date: Date): string {
  const iso = date.toISOString().slice(0, 10);
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function fromBrDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  if (!match) return null;
  const value = new Date(`${match[3]}-${match[2]}-${match[1]}T00:00:00Z`);
  return Number.isNaN(value.getTime()) ? null : value;
}

// ------------------------------------------------------------------- search

export type DouHit = {
  title: string | null;
  urlTitle: string;
  pubDate: Date | null;
  pubName: string | null;
  editionNumber: string | null;
  numberPage: string | null;
  excerpt: string | null;
  artType: string | null;
  hierarchy: string | null;
  url: string;
};

function extractHits(html: string): DouHit[] {
  const match =
    /<script id="_br_com_seatecnologia_in_buscadou_BuscaDouPortlet_params"[^>]*>([\s\S]*?)<\/script>/.exec(
      html,
    );
  if (!match?.[1]) return [];

  let parsed: { jsonArray?: Record<string, string>[] };
  try {
    parsed = JSON.parse(decodeEntities(match[1].trim())) as {
      jsonArray?: Record<string, string>[];
    };
  } catch (error) {
    throw new Error(`DOU result parsing failed: ${(error as Error).message}`);
  }

  return (parsed.jsonArray ?? [])
    .filter((item) => Boolean(item.urlTitle))
    .map((item) => ({
      title: item.title ? stripTags(item.title) : null,
      urlTitle: item.urlTitle!,
      pubDate: fromBrDate(item.pubDate),
      pubName: item.pubName ?? null,
      editionNumber: item.editionNumber ?? null,
      numberPage: item.numberPage ?? null,
      excerpt: item.content ? stripTags(item.content) : null,
      artType: item.artType ?? null,
      hierarchy: item.hierarchyStr ?? null,
      url: `${ITEM_BASE}/${item.urlTitle}`,
    }));
}

async function searchDouPage(input: {
  term: string;
  since: Date;
  until: Date;
  page: number;
}): Promise<DouHit[]> {
  const url = new URL(SEARCH_BASE);
  url.searchParams.set("q", input.term);
  url.searchParams.set("s", "todos");
  url.searchParams.set("exactDate", "personalizado");
  url.searchParams.set("publishFrom", brDate(input.since));
  url.searchParams.set("publishTo", brDate(input.until));
  url.searchParams.set("sortType", "0");
  url.searchParams.set("delta", String(PAGE_SIZE));
  url.searchParams.set("currentPage", String(input.page));

  const response = await fetch(url, {
    headers: { Accept: "text/html", "User-Agent": BROWSER_UA },
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`DOU search failed [${response.status}]: ${html.slice(0, 300)}`);
  }
  return extractHits(html);
}

async function fetchDouItem(hit: DouHit): Promise<{ html: string; plain: string }> {
  const response = await fetch(hit.url, {
    headers: { Accept: "text/html", "User-Agent": BROWSER_UA },
  });
  const html = await response.text();
  if (!response.ok) {
    throw new Error(`DOU item failed [${response.status}]: ${html.slice(0, 300)}`);
  }
  // The act body sits inside the article wrapper; fall back to the whole page.
  const body = /<div[^>]*class="[^"]*texto-dou[^"]*"[\s\S]*?<\/div>\s*<\/div>/.exec(html);
  return { html, plain: stripTags(body?.[0] ?? html) };
}

// ------------------------------------------------------------------- runner

export type BrPassStats = {
  term: string;
  pages: number;
  hits: number;
  ingested: number;
  duplicates: number;
  failed: number;
  out_of_window: number;
  stopped_by: "exhausted" | "ceiling";
};

export async function runBrDouCollection(supabase: SupabaseClient<Database>) {
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
  log("date window", { since: brDate(since), until: brDate(until) });

  const { data: job, error: jobError } = await supabase
    .from("collection_jobs")
    .insert({
      source_id: source.id,
      profile_id: null,
      status: "running",
      started_at: new Date().toISOString(),
      run_params: {
        function: "collect-br-dou",
        job_type: "scheduled",
        api: "in.gov.br-dou-search",
        collector_version: BR_COLLECTOR_VERSION,
        window_start: since.toISOString(),
        window_end: until.toISOString(),
        window_days: WINDOW_DAYS,
        max_pages_per_term: MAX_PAGES_PER_TERM,
        max_docs_per_term: MAX_DOCS_PER_TERM,
        terms: BR_TERMS,
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
    const perTerm: BrPassStats[] = [];
    const seenThisRun = new Set<string>();

    for (const term of BR_TERMS) {
      const stats: BrPassStats = {
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

      pageLoop: for (let page = 1; page <= MAX_PAGES_PER_TERM; page += 1) {
        const hits = await searchDouPage({ term, since, until, page });
        stats.pages = page;
        if (!hits.length) break;

        for (const hit of hits) {
          if (docsThisTerm >= MAX_DOCS_PER_TERM) {
            stats.stopped_by = "ceiling";
            break pageLoop;
          }

          if (hit.pubDate && (hit.pubDate < since || hit.pubDate > until)) {
            stats.out_of_window += 1;
            continue;
          }

          docsThisTerm += 1;
          stats.hits += 1;
          fetched += 1;

          if (seenThisRun.has(hit.urlTitle)) {
            stats.duplicates += 1;
            duplicates += 1;
            continue;
          }
          seenThisRun.add(hit.urlTitle);

          try {
            const { html, plain } = await fetchDouItem(hit);
            if (!plain.trim()) {
              log("empty document skipped", { id: hit.urlTitle });
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
                source_url: hit.url,
                raw_payload: {
                  hit: {
                    title: hit.title,
                    url_title: hit.urlTitle,
                    pub_date: hit.pubDate?.toISOString() ?? null,
                    pub_name: hit.pubName,
                    edition_number: hit.editionNumber,
                    number_page: hit.numberPage,
                    art_type: hit.artType,
                    hierarchy: hit.hierarchy,
                    excerpt: hit.excerpt,
                  },
                  document_html: html,
                  plain_text: plain,
                  search_term: term,
                } as unknown as never,
                content_hash: contentHash,
                collected_at: collectedAt,
                collection_method: "http",
                is_official_domain: source.is_official_domain,
                is_primary_document: source.is_primary_document,
                traceability_level: source.traceability_level,
                institution_class: source.institution_class,
                canonical_url: hit.url,
                http_status: 200,
                content_type: "text/html",
                language: "pt",
                apify_actor_id: null,
                apify_run_id: null,
                collector_version: BR_COLLECTOR_VERSION,
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
              source_url: hit.url,
              jurisdiction_hint: "BR",
              category: "nautical_sweep",
              payload: {
                title: hit.title,
                text_content: plain,
                url: hit.url,
                doc_type: hit.artType,
                identificador: hit.urlTitle,
                numero_oficial: hit.editionNumber,
                departamento: hit.hierarchy,
                published_at: hit.pubDate?.toISOString() ?? null,
                language: "pt",
                tags: ["nautical_sweep"],
                search_term: term,
                collector_version: BR_COLLECTOR_VERSION,
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
              `[collect-br-dou] document failed ${hit.urlTitle}: ${(error as Error).message}`,
            );
            stats.failed += 1;
            failed += 1;
          }
        }

        if (hits.length < PAGE_SIZE) break;
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
    console.error(`[collect-br-dou] run failed: ${message}`);
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
