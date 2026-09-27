import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

/**
 * Legacy (Group B) promotion tool. Raw items are immutable evidence and are
 * NEVER edited here: provenance is checked read-only, passing items are
 * normalized through the same LogoriOn pipeline as v3, and each batch writes
 * exactly one audit_events row.
 */

type LegacyRawRow = {
  id: string;
  source_id: string;
  source_url: string;
  collected_at: string;
  content_hash: string;
  raw_payload: Record<string, unknown> | null;
  is_official_domain: boolean;
  is_primary_document: boolean;
  traceability_level: Database["public"]["Enums"]["traceability_level"];
  institution_class: Database["public"]["Enums"]["institution_class"];
  sources: { domain: string } | null;
};

async function requireStaff(supabase: import("@supabase/supabase-js").SupabaseClient<Database>) {
  const { data, error } = await supabase.rpc("is_staff");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Staff access required.");
}

export const listLegacyDomains = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireStaff(context.supabase);

    const { data: rows, error } = await context.supabase
      .from("raw_items")
      .select("id, sources(domain)")
      .is("item_status", null)
      .limit(2000)
      .returns<Array<{ id: string; sources: { domain: string } | null }>>();
    if (error) throw new Error(error.message);

    const ids = rows.map((r) => r.id);
    const normalized = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data: ns, error: nErr } = await context.supabase
        .from("normalized_items")
        .select("raw_item_id")
        .in("raw_item_id", ids.slice(i, i + 200));
      if (nErr) throw new Error(nErr.message);
      for (const n of ns ?? []) normalized.add(n.raw_item_id);
    }

    const byDomain = new Map<string, { total: number; normalized: number }>();
    for (const r of rows) {
      const domain = r.sources?.domain ?? "(sem fonte)";
      const entry = byDomain.get(domain) ?? { total: 0, normalized: 0 };
      entry.total += 1;
      if (normalized.has(r.id)) entry.normalized += 1;
      byDomain.set(domain, entry);
    }

    return Array.from(byDomain.entries())
      .map(([domain, v]) => ({ domain, total: v.total, normalized: v.normalized, gap: v.total - v.normalized }))
      .sort((a, b) => b.gap - a.gap);
  });

export const runLegacyPromotion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { domain: string }) => {
    if (typeof input?.domain !== "string" || !input.domain) {
      throw new Error("A domain is required.");
    }
    return { domain: input.domain };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireStaff(supabase);

    const { data: rows, error } = await supabase
      .from("raw_items")
      .select(
        "id, source_id, source_url, collected_at, content_hash, raw_payload, is_official_domain, is_primary_document, traceability_level, institution_class, sources(domain)",
      )
      .is("item_status", null)
      .eq("sources.domain", data.domain)
      .limit(500)
      .returns<LegacyRawRow[]>();
    if (error) throw new Error(error.message);
    const candidates = (rows ?? []).filter((r) => r.sources?.domain === data.domain);
    if (!candidates.length) throw new Error("No legacy items found for this domain.");

    const { data: existing, error: exErr } = await supabase
      .from("normalized_items")
      .select("raw_item_id")
      .in(
        "raw_item_id",
        candidates.map((r) => r.id),
      );
    if (exErr) throw new Error(exErr.message);
    const done = new Set((existing ?? []).map((n) => n.raw_item_id));

    // Provenance check (read-only): source_url, collected_at and content_hash
    // must all be present for the item to be promotable.
    const provenanceFailed: Array<{ id: string; missing: string[] }> = [];
    const promotable: LegacyRawRow[] = [];
    for (const item of candidates) {
      if (done.has(item.id)) continue;
      const missing: string[] = [];
      if (!item.source_url) missing.push("source_url");
      if (!item.collected_at) missing.push("collected_at");
      if (!item.content_hash) missing.push("content_hash");
      if (missing.length) provenanceFailed.push({ id: item.id, missing });
      else promotable.push(item);
    }

    const { normalizeWithLogoriOn } = await import("./logorion.server");

    let normalized = 0;
    const normalizeFailed: Array<{ id: string; error: string }> = [];
    for (const item of promotable) {
      const payload = (item.raw_payload ?? {}) as {
        markdown?: string;
        text?: string | unknown;
        html?: string;
        plain_text?: string;
      };
      const content =
        payload.markdown ??
        payload.plain_text ??
        (typeof payload.text === "string" ? payload.text : undefined) ??
        payload.html ??
        "";
      try {
        if (!content.trim()) throw new Error("raw payload has no text content");
        const doc = await normalizeWithLogoriOn({ sourceUrl: item.source_url, content });
        const { error: insErr } = await supabase.from("normalized_items").insert({
          raw_item_id: item.id,
          source_id: item.source_id,
          source_url: item.source_url,
          jurisdiction_hint: doc.jurisdiction_hint,
          category: doc.category,
          payload: doc as unknown as never,
          is_official_domain: item.is_official_domain,
          is_primary_document: item.is_primary_document,
          traceability_level: item.traceability_level,
          institution_class: item.institution_class,
          collected_at: item.collected_at,
        });
        if (insErr) throw new Error(insErr.message);
        normalized += 1;
      } catch (e) {
        normalizeFailed.push({ id: item.id, error: e instanceof Error ? e.message : "Unknown error" });
      }
    }

    const failedCount = provenanceFailed.length + normalizeFailed.length;
    const { error: auditErr } = await supabase.from("audit_events").insert({
      check_type: "consistency",
      target_table: "raw_items",
      result: failedCount === 0 ? "ok" : normalized > 0 ? "partial" : "failed",
      findings: {
        kind: "legacy_promotion",
        domain: data.domain,
        operator_user_id: userId,
        items_checked: candidates.length,
        already_normalized: done.size,
        items_passed: promotable.length,
        items_failed: failedCount,
        normalized,
        provenance_failures: provenanceFailed,
        normalization_failures: normalizeFailed.slice(0, 50),
        run_at: new Date().toISOString(),
      } as never,
      run_at: new Date().toISOString(),
    });
    if (auditErr) throw new Error(`Audit write failed: ${auditErr.message}`);

    return {
      domain: data.domain,
      checked: candidates.length,
      alreadyNormalized: done.size,
      passed: promotable.length,
      provenanceFailed: provenanceFailed.length,
      normalized,
      normalizationFailed: normalizeFailed.length,
    };
  });
