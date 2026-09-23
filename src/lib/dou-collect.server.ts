/**
 * collect-br-dou — scheduled Brazilian gazette collection via Apify (server-only).
 *
 * Actor: brasildados~monitor-diario-oficial-dou-api (input { q: string[], s }).
 *  - The spec's first choice (jenko_systems~diario-oficial-uniao-dou) was tested
 *    and returns the same three stale April 2026 notices for any input.
 *  - This actor searches the CURRENT day's DOU edition only (no date input).
 *  - It charges per result, so every run carries a hard spend + item cap.
 *
 * Boundaries (same as France/Spain): writes only collection_jobs, raw_items,
 * normalized_items; raw_items insert-only, SHA-256 dedup; all items stay
 * unreviewed / internal_only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

const APIFY_BASE = "https://api.apify.com/v2";
export const DOU_ACTOR_ID = "brasildados~monitor-diario-oficial-dou-api";
export const DOU_COLLECTOR_VERSION = "dou-apify-scheduled@1.0.0";

export const SOURCE_DOMAIN = "dou.gov.br";
export const WINDOW_DAYS = 7;
/** Hard ceilings per run (actor bills per result). */
export const MAX_ITEMS_PER_RUN = 40;
export const MAX_CHARGE_USD_PER_RUN = 1.2;
const POLL_MS = 10_000;
const TIMEOUT_MS = 5 * 60_000;

/** Search terms sent to the actor (section DO1 = normative acts). */
export const DOU_SEARCH_TERMS = [
  "embarcação",
  "náutico",
  "navegação",
  "lancha",
  "jet ski",
  "moto aquática",
  "barco",
];

/** Relevance filter applied to title + summary (spec list). */
export const DOU_FILTER_TERMS = [
  "embarcação",
  "nautico",
  "náutico",
  "marinha",
  "porto",
  "navegação",
  "vela",
  "lancha",
  "jet ski",
  "moto aquática",
  "barco",
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

function token(): string {
  const value = process.env["APIFY_API_TOKEN"];
  if (!value) throw new Error("APIFY_API_TOKEN is not configured");
  return value;
}

async function apify<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${APIFY_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Apify request failed [${response.status}]: ${body.slice(0, 400)}`);
  return JSON.parse(body) as T;
}

type ApifyRun = { id: string; status: string; defaultDatasetId: string };

export type DouItem = {
  secao?: string;
  data?: string; // DD/MM/YYYY
  titulo?: string;
  tipo?: string;
  resumo?: string;
  url?: string;
  edicao?: string;
  pagina?: string;
  orgao?: string;
  hierarquia?: string;
  idPublicacao?: string | number;
  termoBuscado?: string;
  [key: string]: unknown;
};

function parseBrDate(raw: string | undefined): Date | null {
  const m = raw?.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const d = new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeText(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const FILTER_NORMALIZED = Array.from(new Set(DOU_FILTER_TERMS.map(normalizeText)));

function matchedTerms(item: DouItem): string[] {
  const haystack = normalizeText(`${item.titulo ?? ""} ${item.resumo ?? ""}`);
  return FILTER_NORMALIZED.filter((term) => new RegExp(`\\b${term}`).test(haystack));
}

async function runActor(): Promise<{ runId: string; items: DouItem[] }> {
  const run = await apify<{ data: ApifyRun }>(
    `/acts/${DOU_ACTOR_ID}/runs?maxItems=${MAX_ITEMS_PER_RUN}&maxTotalChargeUsd=${MAX_CHARGE_USD_PER_RUN}`,
    { method: "POST", body: JSON.stringify({ q: DOU_SEARCH_TERMS, s: "DO1" }) },
  );
  const runId = run.data.id;
  log("actor run started", { runId });

  const deadline = Date.now() + TIMEOUT_MS;
  let current = run.data;
  while (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(current.status)) {
    if (Date.now() > deadline) throw new Error(`Apify run ${runId} did not finish within 5 minutes`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    current = (await apify<{ data: ApifyRun }>(`/actor-runs/${runId}`)).data;
  }
  if (current.status !== "SUCCEEDED") throw new Error(`Apify run ${runId} ended ${current.status}`);

  const items = await apify<DouItem[]>(
    `/datasets/${current.defaultDatasetId}/items?format=json&clean=true`,
  );
  log("dataset fetched", { runId, items: items.length });
  return { runId, items };
}

export async function runDouCollection(supabase: SupabaseClient<Database>) {
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
  const sinceDay = new Date(`${since.toISOString().slice(0, 10)}T00:00:00Z`);

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
        api: "apify",
        actor_id: DOU_ACTOR_ID,
        collector_version: DOU_COLLECTOR_VERSION,
        window_start: since.toISOString(),
        window_end: until.toISOString(),
        window_days: WINDOW_DAYS,
        max_items_per_run: MAX_ITEMS_PER_RUN,
        max_charge_usd_per_run: MAX_CHARGE_USD_PER_RUN,
        search_terms: DOU_SEARCH_TERMS,
        filter_terms: DOU_FILTER_TERMS,
      } as unknown as never,
    })
    .select("id")
    .single();
  if (jobError) throw new Error(`Job insert failed: ${jobError.message}`);
  const jobId = job.id;
  log("job created", { jobId });

  try {
    const { runId, items } = await runActor();
    await supabase.from("collection_jobs").update({ apify_run_id: runId }).eq("id", jobId);

    let fetched = 0;
    let ingested = 0;
    let duplicates = 0;
    let failed = 0;
    let filteredOut = 0;
    let outOfWindow = 0;
    const seenThisRun = new Set<string>();

    for (const item of items) {
      const published = parseBrDate(item.data);
      if (published && published < sinceDay) {
        outOfWindow += 1;
        continue;
      }
      const matches = matchedTerms(item);
      if (!matches.length || !item.url) {
        filteredOut += 1;
        continue;
      }
      fetched += 1;

      const contentHash = await sha256Hex(`${item.url}|${item.titulo ?? ""}|${item.data ?? ""}`);
      if (seenThisRun.has(contentHash)) {
        duplicates += 1;
        continue;
      }
      seenThisRun.add(contentHash);

      try {
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
        const text = [item.titulo, item.resumo].filter(Boolean).join("\n");
        const { data: rawItem, error: rawError } = await supabase
          .from("raw_items")
          .insert({
            job_id: jobId,
            source_id: source.id,
            source_url: item.url,
            raw_payload: { item, matched_terms: matches } as unknown as never,
            content_hash: contentHash,
            collected_at: collectedAt,
            collection_method: "api",
            is_official_domain: source.is_official_domain,
            is_primary_document: source.is_primary_document,
            traceability_level: source.traceability_level,
            institution_class: source.institution_class,
            canonical_url: item.url,
            http_status: 200,
            content_type: "application/json",
            language: "pt",
            apify_actor_id: DOU_ACTOR_ID,
            apify_run_id: runId,
            collector_version: DOU_COLLECTOR_VERSION,
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
          source_url: item.url,
          jurisdiction_hint: "BR",
          category: "nautical_sweep",
          payload: {
            title: item.titulo ?? null,
            text_content: text,
            url: item.url,
            doc_type: item.tipo ?? null,
            identificador: item.idPublicacao ? String(item.idPublicacao) : null,
            orgao: item.orgao ?? item.hierarquia ?? null,
            secao: item.secao ?? null,
            edicao: item.edicao ?? null,
            published_at: published ? published.toISOString() : null,
            language: "pt",
            tags: ["nautical_sweep", ...matches],
            search_term: item.termoBuscado ?? null,
            collector_version: DOU_COLLECTOR_VERSION,
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
        ingested += 1;
      } catch (error) {
        console.error(`[collect-br-dou] item failed ${item.url}: ${(error as Error).message}`);
        failed += 1;
      }
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

    log("run succeeded", { jobId, raw: items.length, filteredOut, outOfWindow, fetched, ingested, duplicates, failed });
    return {
      jobId,
      window: { since: since.toISOString(), until: until.toISOString() },
      found: fetched,
      new_items: ingested,
      duplicates,
      failures: failed,
      actor_results: items.length,
      filtered_out: filteredOut,
      out_of_window: outOfWindow,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    console.error(`[collect-br-dou] run failed: ${message}`);
    await supabase
      .from("collection_jobs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error_text: message })
      .eq("id", jobId);
    throw new Error(message);
  }
}
