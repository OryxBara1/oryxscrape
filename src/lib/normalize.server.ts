/**
 * Normalization of a job's raw items through the real LogoriOn gateway
 * (server-only). Shared by the staff server function and one-off backend runs.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

export async function runNormalizeJob(input: {
  supabase: SupabaseClient<Database>;
  jobId: string;
  limit: number;
}) {
  const { supabase, jobId, limit } = input;

  const { data: rawItems, error: rawError } = await supabase
    .from("raw_items")
    .select(
      "id, source_id, source_url, raw_payload, collected_at, is_official_domain, is_primary_document, traceability_level, institution_class",
    )
    .eq("job_id", jobId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (rawError) throw new Error(rawError.message);
  if (!rawItems.length) return { normalized: 0, skipped: 0, failed: 0 };

  const { data: existing, error: existingError } = await supabase
    .from("normalized_items")
    .select("raw_item_id")
    .in(
      "raw_item_id",
      rawItems.map((item) => item.id),
    );
  if (existingError) throw new Error(existingError.message);
  const done = new Set((existing ?? []).map((row) => row.raw_item_id));

  const { normalizeWithLogoriOn } = await import("./logorion.server");

  let normalized = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of rawItems) {
    if (done.has(item.id)) {
      skipped += 1;
      continue;
    }
    const payload = (item.raw_payload ?? {}) as {
      markdown?: string;
      text?: string | unknown;
      html?: string;
      plain_text?: string;
      concept_code?: string | null;
      concept_label?: string;
      concept_query?: string | null;
      document_label?: string;
    };
    const content =
      payload.markdown ??
      payload.plain_text ??
      (typeof payload.text === "string" ? payload.text : undefined) ??
      payload.html ??
      "";
    try {
      const doc = await normalizeWithLogoriOn({ sourceUrl: item.source_url, content });
      const { error } = await supabase.from("normalized_items").insert({
        raw_item_id: item.id,
        source_id: item.source_id,
        source_url: item.source_url,
        jurisdiction_hint: doc.jurisdiction_hint,
        category: doc.category,
        payload: {
          ...doc,
          ...(payload.concept_label
            ? {
                concept_label: payload.concept_label,
                concept_code: payload.concept_code ?? null,
                concept_query: payload.concept_query ?? null,
              }
            : {}),
          ...(payload.document_label ? { document_label: payload.document_label } : {}),
        } as unknown as never,

        is_official_domain: item.is_official_domain,
        is_primary_document: item.is_primary_document,
        traceability_level: item.traceability_level,
        institution_class: item.institution_class,
        collected_at: item.collected_at,
      });
      if (error) throw new Error(error.message);
      normalized += 1;
    } catch (error) {
      console.error("[normalize] item failed", item.id, (error as Error).message);
      failed += 1;
    }
  }

  return { normalized, skipped, failed };
}
