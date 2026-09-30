/**
 * Blocked-item recording (server-only).
 *
 * When a collector cannot download a document (403, SSL error, JS-only page,
 * empty extraction), the URL is recorded as a raw_item with
 * item_status = 'blocked' instead of being dropped. Staff then pick it up on
 * the Manual Upload Queue screen, download the file in their own browser and
 * upload the extracted text, which creates a superseding 'collected' raw item
 * (raw_items are immutable — never updated in place).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

import { sha256Hex } from "./consumer-keys.server";

export const BLOCKED_COLLECTOR_VERSION = "blocked-record@1.0.0";

type SourceFacts = {
  id: string;
  is_official_domain: boolean;
  is_primary_document: boolean;
  traceability_level: Database["public"]["Enums"]["traceability_level"];
  institution_class: Database["public"]["Enums"]["institution_class"];
};

export async function recordBlockedItem(input: {
  supabase: SupabaseClient<Database>;
  source: SourceFacts;
  url: string;
  error: string;
  jobId?: string | null;
  jurisdictionHint?: string | null;
}): Promise<"recorded" | "duplicate"> {
  const { supabase, source } = input;
  const now = new Date().toISOString();
  const { error } = await supabase.from("raw_items").insert({
    job_id: input.jobId ?? null,
    source_id: source.id,
    source_url: input.url,
    raw_payload: {
      error: input.error.slice(0, 500),
      attempted_at: now,
      ...(input.jurisdictionHint ? { jurisdiction_hint: input.jurisdictionHint } : {}),
    } as unknown as never,
    content_hash: await sha256Hex(`blocked|${source.id}|${input.url}`),
    collected_at: now,
    collection_method: "http",
    is_official_domain: source.is_official_domain,
    is_primary_document: source.is_primary_document,
    traceability_level: source.traceability_level,
    institution_class: source.institution_class,
    canonical_url: input.url,
    collector_version: BLOCKED_COLLECTOR_VERSION,
    item_status: "blocked",
  });
  if (error) {
    if (error.code === "23505") return "duplicate";
    throw new Error(error.message);
  }
  return "recorded";
}
