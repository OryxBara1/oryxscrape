/**
 * Gibraltar (GI) legislation collector — server only.
 *
 * gibraltarlaws.gov.gi has no text search endpoint: consolidated primary and
 * secondary legislation is catalogued under numbered subject topics. This
 * collector walks the maritime subset of those topics, reads the listing rows
 * (each `<div class="tr" data-href="...">` carries date, number and title),
 * opens each act page for the official PDF referenced by its viewer iframe,
 * and extracts the full text with unpdf.
 *
 * Jurisdiction is always GI — never UK. Everything lands in raw_items;
 * normalization and review stay human-gated downstream.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

import { sha256Hex } from "./consumer-keys.server";

export const GIBRALTAR_COLLECTOR_VERSION = "gi-laws-topics@1.0.0";

const ORIGIN = "https://www.gibraltarlaws.gov.gi";
const UA = "OryxScrape/1.0 (+official document collection)";

/** Maritime / port subject topics of the Laws of Gibraltar index. */
export const GIBRALTAR_MARITIME_TOPICS = [
  { topic: 219, label: "PORT" },
  { topic: 287, label: "GIBRALTAR PORT AUTHORITY" },
  { topic: 92, label: "GIBRALTAR MERCHANT SHIPPING" },
  { topic: 263, label: "MERCHANT SHIPPING" },
  { topic: 296, label: "ADMIRALTY WATERS (GIBRALTAR)" },
  { topic: 445, label: "ADMIRALTY WATERS AND NAVAL BASE (GIBRALTAR)" },
  { topic: 187, label: "OIL IN TERRITORIAL WATERS" },
  { topic: 147, label: "SHIP AGENTS (REGISTRATION)" },
] as const;

type SourceFacts = {
  id: string;
  is_official_domain: boolean;
  is_primary_document: boolean;
  traceability_level: Database["public"]["Enums"]["traceability_level"];
  institution_class: Database["public"]["Enums"]["institution_class"];
};

type ListingRow = {
  url: string;
  title: string | null;
  date: string | null;
  number: string | null;
  topic: number;
  topicLabel: string;
};

async function getText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return await response.text();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .trim();
}

/** Pulls the `<p>` that follows a given column header inside one listing row. */
function cell(rowHtml: string, header: string): string | null {
  const pattern = new RegExp(`${header}\\s*<\\/h6>\\s*<p[^>]*>([\\s\\S]*?)<\\/p>`, "i");
  const match = rowHtml.match(pattern);
  if (!match) return null;
  const value = decodeEntities(match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  return value || null;
}

/** Parses one topic listing page into its legislation rows. */
export function parseTopicListing(
  html: string,
  topic: number,
  topicLabel: string,
): ListingRow[] {
  const rows: ListingRow[] = [];
  const chunks = html.split(/<div class="tr"\s+data-href="/i).slice(1);
  for (const chunk of chunks) {
    const end = chunk.indexOf('"');
    if (end < 0) continue;
    const url = decodeEntities(chunk.slice(0, end));
    if (!url.includes("/legislations/")) continue;
    const body = chunk.slice(end, end + 4000);
    rows.push({
      url,
      title: cell(body, "TITLE"),
      date: cell(body, "DATE"),
      number: cell(body, "NUMBER"),
      topic,
      topicLabel,
    });
  }
  return rows;
}

/** Resolves the official PDF referenced by the act page's viewer iframe. */
export function pdfUrlFromActPage(html: string): string | null {
  const match = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (!match) return null;
  const src = decodeEntities(match[1]);
  const hash = src.indexOf("#");
  const target = hash >= 0 ? src.slice(hash + 1) : src;
  if (!/\.pdf$/i.test(target)) return null;
  try {
    return new URL(target, `${ORIGIN}/assets/vendor/viewerjs/`).toString();
  } catch {
    return null;
  }
}

/**
 * Some acts (notices, appointments) carry no PDF and publish the text inline
 * inside the act page's `text-content` block instead.
 */
export function inlineTextFromActPage(html: string): string {
  const start = html.indexOf('class="text-content"');
  if (start < 0) return "";
  const after = html.slice(start);
  const endMarkers = [
    "<!-- Made Under Legislation",
    "<!-- Made From Legislation",
    "<!-- Connected Legislation",
    "<!-- Modified Legislations",
    '<div id="accordion"',
    "<footer",
  ];
  let end = after.length;
  for (const marker of endMarkers) {
    const at = after.indexOf(marker);
    if (at > 0 && at < end) end = at;
  }
  return decodeEntities(
    after
      .slice(0, end)
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t\u00a0]+/g, " ")
      .replace(/\n{3,}/g, "\n\n"),
  );
}



async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n") : text).replace(/\u0000/g, "").trim();
}

export async function runGibraltarCollection(input: {
  supabase: SupabaseClient<Database>;
  source: SourceFacts;
  profileId: string | null;
  /** Hard cap on documents ingested per run. */
  limit?: number;
  /** Subset of topics; defaults to the full maritime set. */
  topics?: readonly { topic: number; label: string }[];
}) {
  const { supabase, source } = input;
  const limit = Math.max(1, Math.min(input.limit ?? 20, 120));
  const topics = input.topics ?? GIBRALTAR_MARITIME_TOPICS;

  const { data: job, error: jobError } = await supabase
    .from("collection_jobs")
    .insert({
      source_id: source.id,
      profile_id: input.profileId,
      status: "running",
      started_at: new Date().toISOString(),
      run_params: { method: "gi-laws-topics", limit, topics: topics.map((t) => t.topic) },
    })
    .select("id")
    .single();
  if (jobError) throw new Error(jobError.message);

  try {
    // 1. Collect candidate acts from every maritime topic, newest first.
    const candidates: ListingRow[] = [];
    const seen = new Set<string>();
    const topicErrors: { topic: number; error: string }[] = [];

    for (const t of topics) {
      try {
        const html = await getText(`${ORIGIN}/legislations?topic=${t.topic}`);
        for (const row of parseTopicListing(html, t.topic, t.label)) {
          if (seen.has(row.url)) continue;
          seen.add(row.url);
          candidates.push(row);
        }
      } catch (error) {
        topicErrors.push({ topic: t.topic, error: (error as Error).message });
      }
    }

    if (!candidates.length) {
      throw new Error(
        `No legislation rows found in ${topics.length} topics${topicErrors.length ? `: ${topicErrors[0].error}` : "."}`,
      );
    }

    // 2. Drop acts already stored, so each run advances into new material.
    const { data: known, error: knownError } = await supabase
      .from("raw_items")
      .select("source_url")
      .eq("source_id", source.id);
    if (knownError) throw new Error(knownError.message);
    const stored = new Set((known ?? []).map((r) => r.source_url));
    const pending = candidates.filter((c) => !stored.has(c.url)).slice(0, limit);

    // 3. Fetch the official PDF of each act and store its full text.
    let ingested = 0;
    let duplicates = 0;
    let failed = 0;
    const perTarget: {
      url: string;
      title: string | null;
      chars: number;
      result: "ingested" | "duplicate" | "failed";
      error?: string;
    }[] = [];

    for (const act of pending) {
      try {
        const actHtml = await getText(act.url);
        const pdfUrl = pdfUrlFromActPage(actHtml);

        let content = "";
        let byteLength = 0;
        let httpStatus: number | null = null;
        let contentType: string | null = "text/html";

        if (pdfUrl) {
          const pdfResponse = await fetch(pdfUrl, {
            headers: { "User-Agent": UA, Accept: "application/pdf,*/*;q=0.8" },
            redirect: "follow",
          });
          if (!pdfResponse.ok) throw new Error(`HTTP ${pdfResponse.status} for the PDF`);
          const bytes = new Uint8Array(await pdfResponse.arrayBuffer());
          content = await extractPdfText(bytes);
          byteLength = bytes.byteLength;
          httpStatus = pdfResponse.status;
          contentType = pdfResponse.headers.get("content-type");
          if (!content) throw new Error("PDF has no extractable text layer.");
        } else {
          // Notices and appointments publish their text inline instead.
          content = inlineTextFromActPage(actHtml);
          byteLength = content.length;
          httpStatus = 200;
          if (content.length < 40) throw new Error("Act page has no PDF and no inline text.");
        }

        const { error } = await supabase.from("raw_items").insert({
          job_id: job.id,
          source_id: source.id,
          source_url: act.url,
          raw_payload: {
            plain_text: content,
            document_label: act.title,
            document_number: act.number,
            document_date: act.date,
            pdf_url: pdfUrl,
            byte_length: byteLength,
            concept_code: `gi-topic-${act.topic}`,
            concept_label: act.topicLabel,
            concept_query: `topic=${act.topic}`,
          } as unknown as never,
          content_hash: await sha256Hex(content),
          collected_at: new Date().toISOString(),
          collection_method: "http",
          is_official_domain: source.is_official_domain,
          is_primary_document: source.is_primary_document,
          traceability_level: source.traceability_level,
          institution_class: source.institution_class,
          canonical_url: act.url,
          http_status: httpStatus,
          content_type: contentType,
          language: "en",
          apify_actor_id: null,
          apify_run_id: null,
          collector_version: GIBRALTAR_COLLECTOR_VERSION,
        });

        if (error) {
          if (error.code === "23505") {
            duplicates += 1;
            perTarget.push({ url: act.url, title: act.title, chars: content.length, result: "duplicate" });
          } else {
            throw new Error(error.message);
          }
        } else {
          ingested += 1;
          perTarget.push({ url: act.url, title: act.title, chars: content.length, result: "ingested" });
        }
      } catch (error) {
        failed += 1;
        const message = (error as Error).message;
        console.error("[gibraltar-collect] failed", act.url, message);
        perTarget.push({ url: act.url, title: act.title, chars: 0, result: "failed", error: message });
      }
    }

    const { error: updateError } = await supabase
      .from("collection_jobs")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        fetched_count: pending.length,
        new_count: ingested,
        duplicate_count: duplicates,
        failed_count: failed,
        ...(topicErrors.length ? { error_text: `topic errors: ${JSON.stringify(topicErrors)}` } : {}),
      })
      .eq("id", job.id);
    if (updateError) throw new Error(updateError.message);

    return {
      jobId: job.id,
      apifyRunId: null,
      candidates: candidates.length,
      remaining: Math.max(
        0,
        candidates.filter((c) => !stored.has(c.url)).length - ingested - duplicates,
      ),
      ingested,
      duplicates,
      failed,
      topicErrors,
      perTarget,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gibraltar collection failed.";
    await supabase
      .from("collection_jobs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error_text: message })
      .eq("id", job.id);
    throw new Error(message);
  }
}
