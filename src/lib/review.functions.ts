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
