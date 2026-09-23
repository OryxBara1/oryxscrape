/**
 * collect-fr-legifrance — scheduled French legislation collection (server-only).
 *
 * Collects recent French legislation from Légifrance through the PISTE gateway,
 * bounded by publication date since the last successful France job.
 *
 * Boundaries:
 *  - Writes ONLY to the OryxScrape schema (collection_jobs, raw_items,
 *    normalized_items). Never to any consumer database.
 *  - raw_items are immutable: insert only, deduplicated by SHA-256 content hash.
 *  - Everything collected stays unreviewed / internal_only. No promotion,
 *    no publication, no handoff.
 *
 * Credentials: PISTE_CLIENT_ID_ORYXSCRAPE / PISTE_CLIENT_SECRET_ORYXSCRAPE.
 * A fresh token is requested on every run.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

const OAUTH_URL = "https://oauth.piste.gouv.fr/api/oauth/token";
const API_BASE = "https://api.piste.gouv.fr/dila/legifrance/lf-engine-app";

export const LEGIFRANCE_COLLECTOR_VERSION = "legifrance-scheduled@1.0.0";

export const SOURCE_DOMAIN = "piste.gouv.fr";
export const FALLBACK_WINDOW_DAYS = 90;
export const MAX_PAGES_PER_CONCEPT = 5;
export const MAX_DOCS_PER_CONCEPT = 100;
const PAGE_SIZE = 20;

/** Nautical / recreational sweep terms — deliberately scoped, not all of LODA. */
export const SWEEP_TERMS = [
  "navire de plaisance",
  "navigation de plaisance",
  "plaisance maritime",
];

function log(step: string, detail?: unknown) {
  if (detail === undefined) console.log(`[collect-fr-legifrance] ${step}`);
  else console.log(`[collect-fr-legifrance] ${step}`, JSON.stringify(detail));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- PISTE auth

/** Fresh client-credentials token per run; never cached, never logged. */
async function getPisteToken(): Promise<string> {
  const clientId = process.env["PISTE_CLIENT_ID_ORYXSCRAPE"];
  const clientSecret = process.env["PISTE_CLIENT_SECRET_ORYXSCRAPE"];
  if (!clientId || !clientSecret) {
    throw new Error(
      "PISTE_CLIENT_ID_ORYXSCRAPE / PISTE_CLIENT_SECRET_ORYXSCRAPE are not configured",
    );
  }

  const response = await fetch(OAUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "openid",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`PISTE OAuth failed [${response.status}]: ${text.slice(0, 300)}`);
  }
  const payload = JSON.parse(text) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error(`PISTE OAuth returned no access_token: ${text.slice(0, 200)}`);
  }
  log("oauth token acquired");
  return payload.access_token;
}

async function piste<T>(token: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Légifrance ${path} failed [${response.status}]: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

// -------------------------------------------------------------- search + doc

type Hit = {
  id: string;
  cid?: string;
  title?: string;
  datePublication?: string | number | null;
  date?: string | number | null;
};

function conceptPhrases(query: string): string[] {
  return query
    .split(/\s+OR\s+/i)
    .map((p) => p.trim().replace(/^["«»]+|["«»]+$/g, "").trim())
    .filter(Boolean);
}

/**
 * One page of a publication-date-bounded LODA search. Synonyms of the same
 * concept are OR'd; concepts are never combined.
 */
async function searchLodaPage(input: {
  token: string;
  query: string;
  since: Date;
  until: Date;
  page: number;
}): Promise<{ hits: Hit[]; dateFilterApplied: boolean }> {
  const phrases = conceptPhrases(input.query);
  if (!phrases.length) return { hits: [], dateFilterApplied: false };

  const champs = phrases.map((phrase) => ({
    typeChamp: "ALL",
    criteres: [
      { typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP", valeur: phrase, operateur: "ET" },
    ],
    operateur: "OU",
  }));

  const recherche = {
    champs,
    filtres: [
      { facette: "DATE_VERSION", singleDate: Date.now() },
      {
        facette: "DATE_PUBLICATION",
        dates: { start: ymd(input.since), end: ymd(input.until) },
      },
    ],
    pageNumber: input.page,
    pageSize: PAGE_SIZE,
    operateur: "ET",
    sort: "PUBLICATION_DATE_DESC",
    typePagination: "DEFAUT",
  };

  const run = (body: unknown) =>
    piste<{ results?: { titles?: Hit[] }[] }>(input.token, "/search", body);

  try {
    const result = await run({ fond: "LODA_DATE", recherche });
    return {
      hits: (result.results ?? []).flatMap((row) => row.titles ?? []),
      dateFilterApplied: true,
    };
  } catch (error) {
    // Some Légifrance deployments reject the publication-date facet or the
    // date sort. Fall back to the plain search; dates are then checked
    // per document after consultation.
    log("search rejected date filter, retrying unfiltered", {
      page: input.page,
      error: (error as Error).message,
    });
    const result = await run({
      fond: "LODA_DATE",
      recherche: {
        ...recherche,
        filtres: [{ facette: "DATE_VERSION", singleDate: Date.now() }],
        sort: "PERTINENCE",
      },
    });
    return {
      hits: (result.results ?? []).flatMap((row) => row.titles ?? []),
      dateFilterApplied: false,
    };
  }
}

function toDate(raw: string | number | null | undefined): Date | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = new Date(raw);
  return Number.isNaN(value.getTime()) ? null : value;
}

type LodaArticle = { num?: string | null; content?: string | null };
type LodaText = {
  id?: string;
  title?: string;
  nor?: string | null;
  nature?: string | null;
  dateParution?: string | number | null;
  datePubli?: string | number | null;
  sections?: { title?: string | null; articles?: LodaArticle[] }[];
  articles?: LodaArticle[];
};

async function consultLawDecree(token: string, textId: string): Promise<LodaText> {
  const result = await piste<{ text?: LodaText } & LodaText>(token, "/consult/lawDecree", {
    textId,
    date: ymd(new Date()),
  });
  return result.text ?? (result as LodaText);
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function toPlainText(text: LodaText): string {
  const parts: string[] = [];
  if (text.title) parts.push(text.title);
  const walk = (articles?: LodaArticle[]) => {
    for (const article of articles ?? []) {
      const body = article.content ? stripTags(article.content) : "";
      if (body) parts.push(article.num ? `Article ${article.num}\n${body}` : body);
    }
  };
  walk(text.articles);
  for (const section of text.sections ?? []) {
    if (section.title) parts.push(section.title);
    walk(section.articles);
  }
  return parts.join("\n\n");
}

function legifranceUrl(textId: string): string {
  return `https://www.legifrance.gouv.fr/loda/id/${textId}`;
}

// ------------------------------------------------------------------- runner

export type PassStats = {
  pass: "concept" | "sweep";
  concept_code: string;
  query: string;
  pages: number;
  hits: number;
  ingested: number;
  duplicates: number;
  failed: number;
  out_of_window: number;
  stopped_by: "exhausted" | "date_window" | "ceiling";
};

export async function runLegifranceCollection(supabase: SupabaseClient<Database>) {
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

  // 2. Lower bound: finished_at of the last successful job for this source
  const { data: lastJob, error: lastJobError } = await supabase
    .from("collection_jobs")
    .select("finished_at")
    .eq("source_id", source.id)
    .eq("status", "succeeded")
    .not("finished_at", "is", null)
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastJobError) throw new Error(`Last job lookup failed: ${lastJobError.message}`);

  const until = new Date();
  const usedFallbackWindow = !lastJob?.finished_at;
  const since = lastJob?.finished_at
    ? new Date(lastJob.finished_at)
    : new Date(Date.now() - FALLBACK_WINDOW_DAYS * 86_400_000);
  log("date window", {
    since: since.toISOString(),
    until: until.toISOString(),
    fallback: usedFallbackWindow,
  });

  // 3. Passes: active French concept terms + the nautical sweep
  const { data: terms, error: termsError } = await supabase
    .from("search_terms")
    .select("concept_code, concept_label, term")
    .eq("country_code", "FR")
    .in("lifecycle_state", ["candidate", "promising", "validated"]);
  if (termsError) throw new Error(`Search term lookup failed: ${termsError.message}`);

  const passes = [
    ...(terms ?? []).map((t) => ({
      pass: "concept" as const,
      concept_code: t.concept_code,
      concept_label: t.concept_label,
      query: t.term,
    })),
    ...SWEEP_TERMS.map((term) => ({
      pass: "sweep" as const,
      concept_code: "nautical_sweep",
      concept_label: "nautical_sweep",
      query: term,
    })),
  ];
  if (!passes.length) throw new Error("No French search terms and no sweep terms to run.");
  log("passes prepared", { concepts: (terms ?? []).length, sweep: SWEEP_TERMS.length });

  // 4. Job row
  const { data: job, error: jobError } = await supabase
    .from("collection_jobs")
    .insert({
      source_id: source.id,
      profile_id: null,
      status: "running",
      started_at: new Date().toISOString(),
      run_params: {
        function: "collect-fr-legifrance",
        job_type: "scheduled",
        api: "piste-legifrance",
        collector_version: LEGIFRANCE_COLLECTOR_VERSION,
        window_start: since.toISOString(),
        window_end: until.toISOString(),
        used_fallback_window: usedFallbackWindow,
        max_pages_per_concept: MAX_PAGES_PER_CONCEPT,
        max_docs_per_concept: MAX_DOCS_PER_CONCEPT,
        sweep_terms: SWEEP_TERMS,
      } as unknown as never,
    })
    .select("id")
    .single();
  if (jobError) throw new Error(`Job insert failed: ${jobError.message}`);
  const jobId = job.id;
  log("job created", { jobId });

  try {
    const token = await getPisteToken();

    let fetched = 0;
    let ingested = 0;
    let duplicates = 0;
    let failed = 0;
    const perPass: PassStats[] = [];
    const seenThisRun = new Set<string>();

    for (const pass of passes) {
      const stats: PassStats = {
        pass: pass.pass,
        concept_code: pass.concept_code,
        query: pass.query,
        pages: 0,
        hits: 0,
        ingested: 0,
        duplicates: 0,
        failed: 0,
        out_of_window: 0,
        stopped_by: "exhausted",
      };

      let page = 1;
      let docsThisConcept = 0;

      pageLoop: while (page <= MAX_PAGES_PER_CONCEPT && docsThisConcept < MAX_DOCS_PER_CONCEPT) {
        const { hits, dateFilterApplied } = await searchLodaPage({
          token,
          query: pass.query,
          since,
          until,
          page,
        });
        stats.pages = page;
        if (!hits.length) break;

        for (const hit of hits) {
          if (docsThisConcept >= MAX_DOCS_PER_CONCEPT) {
            stats.stopped_by = "ceiling";
            break pageLoop;
          }

          const hinted = toDate(hit.datePublication ?? hit.date ?? null);
          if (dateFilterApplied && hinted && hinted < since) {
            // Newest-first: everything beyond this point is older.
            stats.stopped_by = "date_window";
            break pageLoop;
          }

          docsThisConcept += 1;
          stats.hits += 1;
          fetched += 1;

          if (seenThisRun.has(hit.id)) {
            stats.duplicates += 1;
            duplicates += 1;
            continue;
          }
          seenThisRun.add(hit.id);

          try {
            const text = await consultLawDecree(token, hit.id);
            const published = toDate(text.dateParution ?? text.datePubli ?? null) ?? hinted;
            if (published && published < since) {
              // Publication date, not version date: amended old texts are skipped.
              stats.out_of_window += 1;
              continue;
            }

            const content = toPlainText(text);
            if (!content.trim()) {
              log("empty document skipped", { textId: hit.id });
              stats.failed += 1;
              failed += 1;
              continue;
            }

            const url = legifranceUrl(hit.id);
            const contentHash = await sha256Hex(content);

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
                  text,
                  plain_text: content,
                  pass: pass.pass,
                  concept_code: pass.concept_code,
                  concept_label: pass.concept_label,
                  concept_query: pass.query,
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
                language: "fr",
                apify_actor_id: null,
                apify_run_id: null,
                collector_version: LEGIFRANCE_COLLECTOR_VERSION,
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
              jurisdiction_hint: "FR",
              category: pass.concept_code,
              payload: {
                title: text.title ?? hit.title ?? null,
                text_content: content,
                url,
                doc_type: text.nature ?? null,
                nor: text.nor ?? null,
                published_at: published ? published.toISOString() : null,
                language: "fr",
                tags: [pass.concept_code],
                concept_code: pass.concept_code,
                concept_label: pass.concept_label,
                concept_query: pass.query,
                pass: pass.pass,
                collector_version: LEGIFRANCE_COLLECTOR_VERSION,
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
              `[collect-fr-legifrance] document failed ${hit.id}: ${(error as Error).message}`,
            );
            stats.failed += 1;
            failed += 1;
          }
        }

        if (hits.length < PAGE_SIZE) break;
        page += 1;
        if (page > MAX_PAGES_PER_CONCEPT) stats.stopped_by = "ceiling";
      }

      log("pass finished", stats);
      perPass.push(stats);
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
      fetched,
      ingested,
      duplicates,
      failed,
      passes: perPass,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    console.error(`[collect-fr-legifrance] run failed: ${message}`);
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
