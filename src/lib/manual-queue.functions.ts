/**
 * Manual Upload Queue — staff-only server functions.
 *
 * Blocked raw items (collectors could not download the URL) are listed for
 * staff, who download the file in their own browser and upload the extracted
 * text. Because raw_items are immutable, the upload inserts a NEW raw item
 * that supersedes the blocked one; the blocked record stays as history.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const MANUAL_UPLOAD_COLLECTOR_VERSION = "manual-upload@1.0.0";

async function assertStaff(supabase: {
  rpc: (fn: string) => Promise<{ data: unknown; error: { message: string } | null }>;
}) {
  const { data, error } = await supabase.rpc("is_staff");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Staff access required.");
}

type BlockedRow = {
  id: string;
  source_id: string;
  source_url: string;
  collected_at: string;
  collection_method: string;
  raw_payload: Record<string, unknown> | null;
  sources: { name: string } | null;
};

export const listBlockedItems = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertStaff(context.supabase);
    const { data, error } = await context.supabase
      .from("raw_items")
      .select("id, source_id, source_url, collected_at, collection_method, raw_payload, sources(name)")
      .eq("item_status", "blocked")
      .order("collected_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as BlockedRow[];
    if (!rows.length) return [];

    // Hide blocked records that already have a superseding (uploaded) item.
    const { data: superseded, error: supError } = await context.supabase
      .from("raw_items")
      .select("supersedes_raw_item_id")
      .in(
        "supersedes_raw_item_id",
        rows.map((r) => r.id),
      );
    if (supError) throw new Error(supError.message);
    const done = new Set((superseded ?? []).map((r) => r.supersedes_raw_item_id));

    return rows
      .filter((r) => !done.has(r.id))
      .map((r) => ({
        id: r.id,
        sourceId: r.source_id,
        sourceName: r.sources?.name ?? "—",
        sourceUrl: r.source_url,
        collectedAt: r.collected_at,
        collectionMethod: r.collection_method,
        jurisdictionHint:
          typeof r.raw_payload?.jurisdiction_hint === "string"
            ? (r.raw_payload.jurisdiction_hint as string)
            : null,
        error: typeof r.raw_payload?.error === "string" ? (r.raw_payload.error as string) : null,
      }));
  });

export const addBlockedItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        sourceId: z.string().uuid(),
        url: z.string().url(),
        jurisdiction: z.string().trim().max(8).optional(),
        note: z.string().trim().max(500).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertStaff(context.supabase);
    const { data: source, error: sourceError } = await context.supabase
      .from("sources")
      .select("id, is_official_domain, is_primary_document, traceability_level, institution_class")
      .eq("id", data.sourceId)
      .single();
    if (sourceError || !source) throw new Error(sourceError?.message ?? "Source not found.");

    const { recordBlockedItem } = await import("./blocked-items.server");
    const result = await recordBlockedItem({
      supabase: context.supabase,
      source,
      url: data.url,
      error: data.note ? `manual_queue: ${data.note}` : "manual_queue",
      jurisdictionHint: data.jurisdiction || null,
    });
    return { result };
  });

export const submitManualUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        blockedId: z.string().uuid(),
        text: z.string().min(50).max(2_000_000),
        filename: z.string().trim().max(300).optional(),
        mime: z.string().trim().max(120).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertStaff(context.supabase);
    const supabase = context.supabase;

    const { data: blocked, error: blockedError } = await supabase
      .from("raw_items")
      .select(
        "id, source_id, source_url, job_id, language, raw_payload, is_official_domain, is_primary_document, traceability_level, institution_class",
      )
      .eq("id", data.blockedId)
      .eq("item_status", "blocked")
      .single();
    if (blockedError || !blocked) throw new Error("Blocked item not found.");

    const { data: existingSupersede } = await supabase
      .from("raw_items")
      .select("id")
      .eq("supersedes_raw_item_id", blocked.id)
      .limit(1);
    const priorUpload = existingSupersede?.[0];
    if (priorUpload) {
      return { outcome: "already_uploaded" as const, rawItemId: priorUpload.id };
    }

    const { sha256Hex } = await import("./consumer-keys.server");
    const contentHash = await sha256Hex(data.text);

    const blockedPayload = (blocked.raw_payload ?? {}) as Record<string, unknown>;
    const jurisdictionHint =
      typeof blockedPayload["jurisdiction_hint"] === "string"
        ? (blockedPayload["jurisdiction_hint"] as string)
        : null;

    const now = new Date().toISOString();
    const { data: inserted, error: insertError } = await supabase
      .from("raw_items")
      .insert({
        job_id: blocked.job_id,
        source_id: blocked.source_id,
        source_url: blocked.source_url,
        raw_payload: {
          text: data.text,
          plain_text: data.text,
          ...(jurisdictionHint ? { jurisdiction_hint: jurisdictionHint } : {}),
          ...(data.filename ? { original_filename: data.filename } : {}),
          ...(data.mime ? { upload_mime: data.mime } : {}),
          blocked_error: typeof blockedPayload["error"] === "string" ? (blockedPayload["error"] as string) : null,
        } as unknown as never,
        content_hash: contentHash,
        collected_at: now,
        collection_method: "manual",
        is_official_domain: blocked.is_official_domain,
        is_primary_document: blocked.is_primary_document,
        traceability_level: blocked.traceability_level,
        institution_class: blocked.institution_class,
        canonical_url: blocked.source_url,
        content_type: data.mime ?? null,
        language: blocked.language,
        collector_version: MANUAL_UPLOAD_COLLECTOR_VERSION,
        payload_integrity: "verbatim",
        item_status: "collected",
        supersedes_raw_item_id: blocked.id,
      })
      .select("id")
      .single();

    if (insertError) {
      if (insertError.code === "23505") {
        return { outcome: "duplicate" as const };
      }
      throw new Error(insertError.message);
    }

    // Normalize immediately if no normalized item exists yet for this raw item.
    const { data: existingNormalized } = await supabase
      .from("normalized_items")
      .select("id")
      .eq("raw_item_id", inserted.id)
      .limit(1);
    if (existingNormalized?.length) {
      return { outcome: "inserted" as const, rawItemId: inserted.id, normalized: false };
    }

    try {
      const { normalizeWithLogoriOn } = await import("./logorion.server");
      const doc = await normalizeWithLogoriOn({ sourceUrl: blocked.source_url, content: data.text });
      const { error: normError } = await supabase.from("normalized_items").insert({
        raw_item_id: inserted.id,
        source_id: blocked.source_id,
        source_url: blocked.source_url,
        jurisdiction_hint: doc.jurisdiction_hint ?? jurisdictionHint,
        category: doc.category,
        payload: doc as unknown as never,
        is_official_domain: blocked.is_official_domain,
        is_primary_document: blocked.is_primary_document,
        traceability_level: blocked.traceability_level,
        institution_class: blocked.institution_class,
        collected_at: now,
      });
      if (normError) throw new Error(normError.message);
      return { outcome: "inserted" as const, rawItemId: inserted.id, normalized: true };
    } catch (error) {
      console.error("[manual-queue] normalization failed", inserted.id, (error as Error).message);
      return {
        outcome: "inserted" as const,
        rawItemId: inserted.id,
        normalized: false,
        warning: `Uploaded, but normalization failed: ${(error as Error).message}. Retry from Collection jobs.`,
      };
    }
  });
