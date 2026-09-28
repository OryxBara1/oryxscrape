import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { docTypeFromCelex } from "@/lib/curation";

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

type QueueRowDb = {
  id: string;
  source_url: string;
  jurisdiction_hint: string | null;
  payload: Record<string, unknown> | null;
  tags: string[] | null;
  collected_at: string;
  sources: { domain: string } | null;
};

export type ReviewQueueItem = {
  id: string;
  title: string | null;
  celex: string | null;
  docType: string | null;
  date: string | null;
  sourceUrl: string;
  domain: string | null;
  jurisdictionHint: string | null;
  tags: string[];
  collectedAt: string;
};

/** Guided review queue: unreviewed normalized items, oldest first. */
export const listReviewQueue = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { jurisdiction?: string | null; domain?: string | null }) => input ?? {})
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("normalized_items")
      .select("id, source_url, jurisdiction_hint, payload, tags, collected_at, sources(domain)")
      .eq("verification_status", "unreviewed")
      .order("collected_at", { ascending: true })
      .limit(500);
    if (data.jurisdiction) query = query.eq("jurisdiction_hint", data.jurisdiction);

    const { data: rows, error } = await query.returns<QueueRowDb[]>();
    if (error) throw new Error(error.message);

    const items: ReviewQueueItem[] = rows.map((r) => {
      const p = r.payload ?? {};
      const celex = str(p["celexNumber"]);
      return {
        id: r.id,
        title: str(p["title"]),
        celex,
        docType: celex ? docTypeFromCelex(celex) : null,
        date: str(p["published_at"]) ?? str(p["publication_date"]),
        sourceUrl: r.source_url,
        domain: r.sources?.domain ?? null,
        jurisdictionHint: r.jurisdiction_hint,
        tags: r.tags ?? [],
        collectedAt: r.collected_at,
      };
    });

    if (data.domain) return items.filter((i) => i.domain === data.domain);
    return items;
  });

/** Per-jurisdiction counters for the guided review sidebar. */
export const countReviewByJurisdiction = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("normalized_items")
      .select("jurisdiction_hint")
      .eq("verification_status", "unreviewed")
      .limit(2000);
    if (error) throw new Error(error.message);

    const counts = new Map<string, number>();
    for (const row of data ?? []) {
      const key = row.jurisdiction_hint ?? "—";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([jurisdiction, count]) => ({ jurisdiction, count }))
      .sort((a, b) => b.count - a.count);
  });

/** Capy copilot: advisory answer about one item. Never alters review state. */
export const askCapy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { itemId: string; question: string }) => {
    if (!input?.itemId || typeof input.question !== "string" || !input.question.trim()) {
      throw new Error("Pergunta inválida");
    }
    return { itemId: input.itemId, question: input.question.trim().slice(0, 2000) };
  })
  .handler(async ({ data, context }) => {
    const { data: item, error } = await context.supabase
      .from("normalized_items")
      .select("id, source_url, jurisdiction_hint, category, payload, raw_item_id")
      .eq("id", data.itemId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!item) throw new Error("Item não encontrado");

    let fullText = "";
    if (item.raw_item_id) {
      const { data: raw } = await context.supabase
        .from("raw_items")
        .select("raw_payload")
        .eq("id", item.raw_item_id)
        .maybeSingle();
      const rp = (raw?.raw_payload ?? {}) as Record<string, unknown>;
      fullText =
        [rp["markdown"], rp["plain_text"], rp["text"], rp["html"]].find(
          (v): v is string => typeof v === "string" && v.trim() !== "",
        ) ?? "";
    }

    const document = [
      `URL: ${item.source_url}`,
      `Jurisdição: ${item.jurisdiction_hint ?? "—"}`,
      `Categoria: ${item.category ?? "—"}`,
      `Metadados normalizados: ${JSON.stringify(item.payload ?? {})}`,
      fullText ? `Texto da fonte:\n${fullText}` : "Texto integral da fonte indisponível.",
    ].join("\n");

    const { askCapyCopilot } = await import("./logorion.server");
    const answer = await askCapyCopilot({ document, question: data.question });
    return { answer };
  });

/**
 * Staff-triggered, bounded enrichment of the review queue with LogoriOn v2.
 * Adds summary/tags/score to payload.enrichment only; never touches review or
 * publication status, jurisdiction or title. Idempotent: skips enriched items.
 * Stops on the first gateway failure (circuit breaker).
 */
export const enrichQueueBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const BATCH = 5;
    const { data: rows, error } = await context.supabase
      .from("normalized_items")
      .select("id, source_url, payload, raw_item_id")
      .eq("verification_status", "unreviewed")
      .is("payload->enrichment", null)
      .order("collected_at", { ascending: true })
      .limit(BATCH);
    if (error) throw new Error(error.message);

    const { normalizeWithLogoriOn } = await import("./logorion.server");
    let enriched = 0;
    let stopped: string | null = null;
    for (const row of rows ?? []) {
      let content = "";
      if (row.raw_item_id) {
        const { data: raw } = await context.supabase
          .from("raw_items").select("raw_payload").eq("id", row.raw_item_id).maybeSingle();
        const rp = (raw?.raw_payload ?? {}) as Record<string, unknown>;
        content = [rp["markdown"], rp["plain_text"], rp["text"], rp["html"]].find(
          (v): v is string => typeof v === "string" && v.trim() !== "",
        ) ?? "";
      }
      if (!content) content = JSON.stringify(row.payload ?? {});
      try {
        const doc = await normalizeWithLogoriOn({ sourceUrl: row.source_url, content });
        const payload = { ...((row.payload ?? {}) as Record<string, unknown>) };
        payload["enrichment"] = {
          summary: doc.summary, suggested_tags: doc.suggested_tags, relevance_score: doc.relevance_score,
          body_excerpt: doc.body_excerpt, document_reference: doc.document_reference,
          issued_at: doc.issued_at, language: doc.language,
          model: "logorion.v2", enriched_at: new Date().toISOString(),
        };
        const { error: upErr } = await context.supabase
          .from("normalized_items").update({ payload: payload as never }).eq("id", row.id);
        if (upErr) throw new Error(upErr.message);
        enriched += 1;
      } catch (e) {
        stopped = (e as Error).message;
        break;
      }
    }
    const { count } = await context.supabase
      .from("normalized_items").select("id", { count: "exact", head: true })
      .eq("verification_status", "unreviewed").is("payload->enrichment", null);
    return { enriched, remaining: count ?? 0, stopped };
  });
