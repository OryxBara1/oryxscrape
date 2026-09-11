/**
 * PISTE / Légifrance collection (server-only).
 *
 * Runs synchronously: OAuth token -> LODA search -> consult each hit ->
 * immutable raw_items rows with collection_method 'api'. Apify columns stay
 * NULL because no actor/run is involved.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

import {
  PISTE_COLLECTOR_VERSION,
  consultLawDecree,
  legifranceUrl,
  lodaTextToPlainText,
  searchLoda,
} from "./piste.server";
import { sha256Hex } from "./consumer-keys.server";

type SourceFacts = {
  id: string;
  is_official_domain: boolean;
  is_primary_document: boolean;
  traceability_level: Database["public"]["Enums"]["traceability_level"];
  institution_class: Database["public"]["Enums"]["institution_class"];
};

export type ConceptQuery = { concept_label: string; query: string };

export async function runPisteCollection(input: {
  supabase: SupabaseClient<Database>;
  source: SourceFacts;
  profileId: string | null;
  /** Each concept is searched separately; concepts are never combined. */
  concepts: ConceptQuery[];
  /** Max results kept per concept. */
  maxItems: number;
}) {
  const { supabase, source } = input;
  const concepts = input.concepts.filter((c) => c.query.trim() !== "");
  if (!concepts.length) throw new Error("No concept queries provided.");

  const { data: job, error: jobError } = await supabase
    .from("collection_jobs")
    .insert({
      source_id: source.id,
      profile_id: input.profileId,
      status: "running",
      started_at: new Date().toISOString(),
      run_params: {
        api: "piste-legifrance",
        maxItemsPerConcept: input.maxItems,
        concepts,
      },
    })
    .select("id")
    .single();
  if (jobError) throw new Error(jobError.message);

  try {
    let fetched = 0;
    let ingested = 0;
    let duplicates = 0;
    let failed = 0;
    const perConcept: {
      concept_label: string;
      query: string;
      hits: number;
      ingested: number;
      duplicates: number;
      failed: number;
    }[] = [];

    for (const concept of concepts) {
      const hits = (await searchLoda({ query: concept.query, pageSize: input.maxItems })).slice(
        0,
        input.maxItems,
      );
      fetched += hits.length;
      const stats = {
        concept_label: concept.concept_label,
        query: concept.query,
        hits: hits.length,
        ingested: 0,
        duplicates: 0,
        failed: 0,
      };

      for (const hit of hits) {
        try {
          const text = await consultLawDecree(hit.id);
          const content = lodaTextToPlainText(text);
          if (!content.trim()) {
            stats.failed += 1;
            failed += 1;
            continue;
          }
          const url = legifranceUrl(hit.id);
          const { error } = await supabase.from("raw_items").insert({
            job_id: job.id,
            source_id: source.id,
            source_url: url,
            raw_payload: {
              hit,
              text,
              plain_text: content,
              // traceability: which concept term surfaced this document
              concept_label: concept.concept_label,
              concept_query: concept.query,
            } as unknown as never,
            content_hash: await sha256Hex(content),
            collected_at: new Date().toISOString(),
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
            collector_version: PISTE_COLLECTOR_VERSION,
          });
          if (error) {
            if (error.code === "23505") {
              stats.duplicates += 1;
              duplicates += 1;
            } else {
              stats.failed += 1;
              failed += 1;
            }
          } else {
            stats.ingested += 1;
            ingested += 1;
          }
        } catch (error) {
          console.error("[piste] consult failed", hit.id, (error as Error).message);
          stats.failed += 1;
          failed += 1;
        }
      }

      perConcept.push(stats);
    }

    const { error: updateError } = await supabase
      .from("collection_jobs")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        fetched_count: fetched,
        new_count: ingested,
        duplicate_count: duplicates,
        failed_count: failed,
      })
      .eq("id", job.id);
    if (updateError) throw new Error(updateError.message);

    return { jobId: job.id, apifyRunId: null, ingested, duplicates, failed, perConcept };

  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to call the Légifrance API.";
    await supabase
      .from("collection_jobs")
      .update({ status: "failed", finished_at: new Date().toISOString(), error_text: message })
      .eq("id", job.id);
    throw new Error(message);
  }
}
