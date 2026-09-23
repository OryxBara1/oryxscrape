/**
 * collect-hr-nn — scheduled Croatian legislation collection (server-only).
 *
 * Narodne novine has no public API and its keyword search is an ASP.NET
 * postback that cannot be driven from a plain HTTP client (GET keyword
 * parameters are silently ignored, and the form postback is rejected).
 *
 * What DOES work over plain HTTP is the official-gazette issue listing:
 *   https://narodne-novine.nn.hr/search.aspx?godina=YYYY&broj=N&...
 * which returns every article of one issue plus the issue's publication date,
 * and each article page (/clanci/sluzbeni/YYYY_MM_ISSUE_ARTICLE.html) carries
 * the full consolidated text.
 *
 * So this collector walks the issues published inside the rolling window,
 * newest first, and keeps only the articles whose title or text mentions one
 * of the Croatian nautical terms. Everything else is read and discarded.
 *
 * Boundaries:
 *  - Writes ONLY to the OryxScrape schema (collection_jobs, raw_items,
 *    normalized_items). Never to any consumer database.
 *  - raw_items are immutable: insert only, deduplicated by SHA-256.
 *  - Everything collected stays unreviewed / internal_only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

const BASE = "https://narodne-novine.nn.hr";
const UA = "OryxScrape/1.0 (+https://oryxscrape.lovable.app)";

export const NN_COLLECTOR_VERSION = "nn-scheduled@1.0.0";
export const SOURCE_DOMAIN = "narodne-novine.nn.hr";
export const WINDOW_DAYS = 7;
/** Hard safety ceilings — a normal weekly run stays far below these. */
export const MAX_ISSUES = 12;
export const MAX_ARTICLES_PER_ISSUE = 200;
export const MAX_DOCS_PER_RUN = 100;

/** Croatian nautical / recreational navigation terms. */
export const NN_TERMS = [
  "plovilo",
  "nautičar",
  "nautički turizam",
  "plovidba",
  "jahta",
  "brodica",
  "plovni put",
  "marina",
  "jedrilica",
];

function log(step: string, detail?: unknown) {
  if (detail === undefined) console.log(`[collect-hr-nn] ${step}`);
  else console.log(`[collect-hr-nn] ${step}`, JSON.stringify(detail));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "hr" },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`NN fetch failed [${response.status}] ${url}: ${text.slice(0, 200)}`);
  }
  return text;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

function stripHtml(html: string): string {
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

/** Matching ignores case and diacritics, so "Jahtā"/"JAHTA" still match. */
function fold(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const FOLDED_TERMS = NN_TERMS.map((term) => ({ term, folded: fold(term) }));

function matchTerms(text: string): string[] {
  const folded = fold(text);
  return FOLDED_TERMS.filter((entry) => folded.includes(entry.folded)).map((e) => e.term);
}

/** Croatian dates render as d.m.yyyy. */
function parseHrDate(raw: string): Date | null {
  const match = /(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})/.exec(raw);
  if (!match) return null;
  const [, d, m, y] = match;
  const value = new Date(
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T00:00:00Z`,
  );
  return Number.isNaN(value.getTime()) ? null : value;
}

// ------------------------------------------------------------------ listings

export type NnArticle = {
  path: string; // /clanci/sluzbeni/2026_09_107_1286.html
  url: string;
  title: string;
  issueYear: number;
  issueNumber: number;
};

function issueUrl(year: number, issueNumber: number): string {
  return `${BASE}/search.aspx?sortiraj=4&kategorija=1&godina=${year}&broj=${issueNumber}&rpp=${MAX_ARTICLES_PER_ISSUE}&qtype=1&pretraga=da`;
}

/** Newest published issue, read off the default (latest articles) listing. */
async function findLatestIssue(): Promise<{ year: number; issueNumber: number }> {
  const html = await fetchHtml(
    `${BASE}/search.aspx?sortiraj=4&kategorija=1&rpp=20&qtype=1&pretraga=da`,
  );
  const matches = [...html.matchAll(/clanci\/sluzbeni\/(\d{4})_(\d{2})_(\d+)_\d+/g)];
  if (!matches.length) throw new Error("Could not determine the latest Narodne novine issue");
  let best = { year: 0, issueNumber: 0 };
  for (const m of matches) {
    const year = Number(m[1]);
    const issueNumber = Number(m[3]);
    if (year > best.year || (year === best.year && issueNumber > best.issueNumber)) {
      best = { year, issueNumber };
    }
  }
  return best;
}

async function readIssue(
  year: number,
  issueNumber: number,
): Promise<{ publishedAt: Date | null; articles: NnArticle[] }> {
  const html = await fetchHtml(issueUrl(year, issueNumber));

  const articles: NnArticle[] = [];
  const seen = new Set<string>();
  const re =
    /href="(\/clanci\/sluzbeni\/(\d{4})_\d{2}_(\d+)_\d+\.html)"[^>]*>([\s\S]{0,600}?)<\/a>/g;
  for (const m of html.matchAll(re)) {
    const path = m[1];
    if (seen.has(path)) continue;
    seen.add(path);
    const title = decodeEntities(m[4].replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    articles.push({
      path,
      url: `${BASE}${path}`,
      title,
      issueYear: Number(m[2]),
      issueNumber: Number(m[3]),
    });
  }

  // The issue listing prints the issue's publication date.
  const dates = [...html.matchAll(/(\d{1,2}\.\s?\d{1,2}\.\s?\d{4})/g)]
    .map((m) => parseHrDate(m[1]))
    .filter((d): d is Date => d !== null);
  const publishedAt = dates.length ? dates[0] : null;

  return { publishedAt, articles };
}

// ------------------------------------------------------------------- runner

export type NnIssueStats = {
  year: number;
  issue: number;
  published_at: string | null;
  articles: number;
  matched: number;
  ingested: number;
  duplicates: number;
  failed: number;
};

export async function runNnCollection(supabase: SupabaseClient<Database>) {
  log("run started");

  const { data: source, error: sourceError } = await supabase
    .from("sources")
    .select(
      "id, name, domain, is_official_domain, is_primary_document, traceability_level, institution_class",
    )
    .eq("domain", SOURCE_DOMAIN)
    .eq("is_active", true)
    .eq("schedule_enabled", true)
    .maybeSingle();
  if (sourceError) throw new Error(`Source lookup failed: ${sourceError.message}`);
  if (!source) throw new Error(`No scheduled active source found for domain ${SOURCE_DOMAIN}`);
  log("source resolved", { id: source.id, name: source.name });

  const until = new Date();
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  log("date window", { since: since.toISOString(), until: until.toISOString() });

  const { data: job, error: jobError } = await supabase
    .from("collection_jobs")
    .insert({
      source_id: source.id,
      profile_id: null,
      status: "running",
      started_at: new Date().toISOString(),
      run_params: {
        function: "collect-hr-nn",
        job_type: "scheduled",
        api: "nn-issue-listing",
        collector_version: NN_COLLECTOR_VERSION,
        window_start: since.toISOString(),
        window_end: until.toISOString(),
        window_days: WINDOW_DAYS,
        max_issues: MAX_ISSUES,
        max_docs_per_run: MAX_DOCS_PER_RUN,
        terms: NN_TERMS,
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
    let scanned = 0;
    const issues: NnIssueStats[] = [];
    const seenThisRun = new Set<string>();

    const latest = await findLatestIssue();
    log("latest issue", latest);

    let year = latest.year;
    let issueNumber = latest.issueNumber;

    issueLoop: for (let step = 0; step < MAX_ISSUES; step += 1) {
      if (issueNumber < 1) {
        // Year rollover: previous year's issue numbering is unknown from here.
        log("reached start of year — stopping", { year });
        break;
      }

      const stats: NnIssueStats = {
        year,
        issue: issueNumber,
        published_at: null,
        articles: 0,
        matched: 0,
        ingested: 0,
        duplicates: 0,
        failed: 0,
      };

      let issueData: Awaited<ReturnType<typeof readIssue>>;
      try {
        issueData = await readIssue(year, issueNumber);
      } catch (error) {
        console.error(
          `[collect-hr-nn] issue ${year}/${issueNumber} failed: ${(error as Error).message}`,
        );
        stats.failed += 1;
        failed += 1;
        issues.push(stats);
        issueNumber -= 1;
        continue;
      }

      stats.published_at = issueData.publishedAt ? issueData.publishedAt.toISOString() : null;
      stats.articles = issueData.articles.length;

      if (issueData.publishedAt && issueData.publishedAt < since) {
        log("issue older than window — stopping", { year, issueNumber, published: stats.published_at });
        issues.push(stats);
        break;
      }

      for (const article of issueData.articles) {
        if (ingested >= MAX_DOCS_PER_RUN) {
          log("document ceiling reached");
          issues.push(stats);
          break issueLoop;
        }
        if (seenThisRun.has(article.url)) continue;
        seenThisRun.add(article.url);
        scanned += 1;

        try {
          const html = await fetchHtml(article.url);
          const plain = stripHtml(html);
          const terms = matchTerms(`${article.title}\n${plain}`);
          if (!terms.length) continue;

          stats.matched += 1;
          fetched += 1;

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
          const publishedAt = issueData.publishedAt ? issueData.publishedAt.toISOString() : null;

          const { data: rawItem, error: rawError } = await supabase
            .from("raw_items")
            .insert({
              job_id: jobId,
              source_id: source.id,
              source_url: article.url,
              raw_payload: {
                title: article.title,
                issue: { year: article.issueYear, number: article.issueNumber },
                published_at: publishedAt,
                document_html: html,
                plain_text: plain,
                matched_terms: terms,
              } as unknown as never,
              content_hash: contentHash,
              collected_at: collectedAt,
              collection_method: "http",
              is_official_domain: source.is_official_domain,
              is_primary_document: source.is_primary_document,
              traceability_level: source.traceability_level,
              institution_class: source.institution_class,
              canonical_url: article.url,
              http_status: 200,
              content_type: "text/html",
              language: "hr",
              apify_actor_id: null,
              apify_run_id: null,
              collector_version: NN_COLLECTOR_VERSION,
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
            source_url: article.url,
            jurisdiction_hint: "HR",
            category: "nautical_sweep",
            payload: {
              title: article.title || null,
              text_content: plain,
              url: article.url,
              issue: `${article.issueNumber}/${article.issueYear}`,
              published_at: publishedAt,
              language: "hr",
              tags: ["nautical_sweep"],
              matched_terms: terms,
              collector_version: NN_COLLECTOR_VERSION,
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
            `[collect-hr-nn] article failed ${article.url}: ${(error as Error).message}`,
          );
          stats.failed += 1;
          failed += 1;
        }
      }

      log("issue finished", stats);
      issues.push(stats);
      issueNumber -= 1;
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

    log("run succeeded", { jobId, scanned, fetched, ingested, duplicates, failed });
    return {
      jobId,
      window: { since: since.toISOString(), until: until.toISOString() },
      scanned,
      found: fetched,
      new_items: ingested,
      duplicates,
      failures: failed,
      issues,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    console.error(`[collect-hr-nn] run failed: ${message}`);
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
