/**
 * Greece (ΦΕΚ) collection — server only.
 *
 * Search the open et.gr API for the most recent Series B issues (or take
 * explicit targets), download each PDF from the public blob store and extract
 * its text layer. Immutable raw_items rows with collection_method 'api';
 * Apify columns stay NULL because no actor/run is involved.
 *
 * Pre-2000 issues are scanned images without a text layer and are out of scope
 * for this path (they need the OCR fallback).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

import { FEK_COLLECTOR_VERSION, FEK_ISSUE_B, latestFekIssues, type FekEntry } from "./fek.server";
import { sha256Hex } from "./consumer-keys.server";

type SourceFacts = {
  id: string;
  is_official_domain: boolean;
  is_primary_document: boolean;
  traceability_level: Database["public"]["Enums"]["traceability_level"];
  institution_class: Database["public"]["Enums"]["institution_class"];
};

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n") : text).replace(/\u0000/g, "").trim();
}

export async function runFekCollection(input: {
  supabase: SupabaseClient<Database>;
  source: SourceFacts;
  profileId: string | null;
  /** Rolling window: how many of the most recent issues to take. */
  limit?: number;
  year?: number;
  issue?: string;
  /** Explicit targets, used by manual hunts for a known ΦΕΚ. */
  targets?: FekEntry[];
  /** Taxonomy concept that drove this run, tagged onto every ingested row. */
  concept?: { concept_code?: string; concept_label: string; concept_query?: string };
}) {
  const { supabase, source } = input;
  const issue = input.issue ?? FEK_ISSUE_B;
  const year = input.year ?? new Date().getUTCFullYear();
  const limit = Math.min(Math.max(input.limit ?? 4, 1), 25);

  const entries =
    input.targets?.length
      ? input.targets
      : await latestFekIssues({ year, issue, limit });

  const { data: job, error: jobError } = await supabase
    .from("collection_jobs")
    .insert({
      source_id: source.id,
      profile_id: input.profileId,
      status: "running",
      started_at: new Date().toISOString(),
      run_params: {
        api: "et.gr-fek",
        issue,
        year,
        limit,
        targets: entries.map((e) => ({ label: e.label, url: e.pdfUrl })),
      },
    })
    .select("id")
    .single();
  if (jobError) throw new Error(jobError.message);

  try {
    let ingested = 0;
    let duplicates = 0;
    let failed = 0;
    const perTarget: {
      url: string;
      label: string | null;
      chars: number;
      result: "ingested" | "duplicate" | "failed";
      error?: string;
    }[] = [];

    for (const entry of entries) {
      try {
        const response = await fetch(entry.pdfUrl, {
          headers: { Accept: "application/pdf,*/*" },
          redirect: "follow",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const content = await extractPdfText(bytes);
        if (!content) {
          throw new Error("ΦΕΚ has no extractable text layer (likely a pre-2000 scan).");
        }

        const { error } = await supabase.from("raw_items").insert({
          job_id: job.id,
          source_id: source.id,
          source_url: entry.pdfUrl,
          raw_payload: {
            plain_text: content,
            document_label: entry.label,
            ...(input.concept
              ? {
                  concept_label: input.concept.concept_label,
                  concept_code: input.concept.concept_code ?? null,
                  concept_query: input.concept.concept_query ?? null,
                }
              : {}),
            fek_issue: entry.issue,
            fek_year: entry.year,
            fek_document_number: entry.documentNumber,
            fek_issue_date: entry.issueDate,
            byte_length: bytes.byteLength,
          } as unknown as never,
          content_hash: await sha256Hex(content),
          collected_at: new Date().toISOString(),
          collection_method: "api",
          is_official_domain: source.is_official_domain,
          is_primary_document: source.is_primary_document,
          traceability_level: source.traceability_level,
          institution_class: source.institution_class,
          canonical_url: entry.pdfUrl,
          http_status: response.status,
          content_type: response.headers.get("content-type"),
          language: "el",
          apify_actor_id: null,
          apify_run_id: null,
          collector_version: FEK_COLLECTOR_VERSION,
        });

        if (error) {
          if (error.code === "23505") {
            duplicates += 1;
            perTarget.push({
              url: entry.pdfUrl,
              label: entry.label,
              chars: content.length,
              result: "duplicate",
            });
          } else {
            throw new Error(error.message);
          }
        } else {
          ingested += 1;
          perTarget.push({
            url: entry.pdfUrl,
            label: entry.label,
            chars: content.length,
            result: "ingested",
          });
        }
      } catch (error) {
        failed += 1;
        const message = (error as Error).message;
        console.error("[fek-collect] failed", entry.pdfUrl, message);
        perTarget.push({
          url: entry.pdfUrl,
          label: entry.label,
          chars: 0,
          result: "failed",
          error: message,
        });
      }
    }

    const { error: updateError } = await supabase
      .from("collection_jobs")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        fetched_count: entries.length,
        new_count: ingested,
        duplicate_count: duplicates,
        failed_count: failed,
      })
      .eq("id", job.id);
    if (updateError) throw new Error(updateError.message);

    return { jobId: job.id, apifyRunId: null, ingested, duplicates, failed, perTarget };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to collect ΦΕΚ documents.";
    await supabase
      .from("collection_jobs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error_text: message })
      .eq("id", job.id);
    throw new Error(message);
  }
}
