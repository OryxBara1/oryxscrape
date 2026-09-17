import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listHandoffCandidates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { suggestLocale } = await import("./exchange-config");
    const { data: items, error } = await context.supabase
      .from("normalized_items")
      .select(
        "id, source_url, jurisdiction_hint, category, payload, collected_at, updated_at, sources(name, domain)",
      )
      .eq("verification_status", "reviewed")
      .eq("publication_status", "eligible")
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);

    const { data: handoffs, error: handoffError } = await context.supabase
      .from("exchange_handoffs")
      .select("normalized_item_id, state");
    if (handoffError) throw new Error(handoffError.message);

    const taken = new Set(
      (handoffs ?? []).filter((h) => h.state !== "error").map((h) => h.normalized_item_id),
    );

    return (items ?? []).map((item) => {
      const payload = (item.payload ?? {}) as Record<string, unknown>;
      const title = typeof payload["title"] === "string" ? (payload["title"] as string) : null;
      const source = item.sources as unknown as { name?: string; domain?: string } | null;
      const locale = suggestLocale({
        sourceName: source?.name ?? null,
        sourceDomain: source?.domain ?? null,
        sourceUrl: item.source_url,
      });
      return {
        id: item.id,
        sourceUrl: item.source_url,
        sourceName: source?.name ?? null,
        title,
        category: item.category,
        jurisdictionHint: item.jurisdiction_hint,
        collectedAt: item.collected_at,
        alreadySent: taken.has(item.id),
        suggestedCountryCode: locale?.countryCode ?? null,
        suggestedLanguageCode: locale?.languageCode ?? null,
      };
    });
  });

export const listHandoffs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("exchange_handoffs")
      .select(
        "id, exchange_item_id, normalized_item_id, artifact_filename, artifact_sha256, artifact_size_bytes, country_code, language_code, state, sent_at, reason_code, reason_detail, drive_folder_id, drive_artifact_file_id, drive_metadata_file_id, last_synced_at, error_reason, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const listSuppressions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("exchange_suppressions")
      .select(
        "id, exchange_item_id, rule_kind, match_value, strength, reason_code, reason_detail, is_active, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const packageAndSendHandoff = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { normalizedItemId: string; countryCode: string; languageCode: string }) => {
      if (typeof input?.normalizedItemId !== "string" || !input.normalizedItemId) {
        throw new Error("A normalized item id is required.");
      }
      const country = (input.countryCode ?? "").trim().toUpperCase();
      const language = (input.languageCode ?? "").trim().toLowerCase();
      if (!/^[A-Z]{2}$/.test(country)) throw new Error("Confirm a 2-letter country code.");
      if (!/^[a-z]{2}$/.test(language)) throw new Error("Confirm a 2-letter language code.");
      return { normalizedItemId: input.normalizedItemId, countryCode: country, languageCode: language };
    },
  )
  .handler(async ({ data, context }) => {
    const exchange = await import("./exchange.server");
    return exchange.packageAndSend(context.supabase, context.userId, data);
  });

export const batchSendHandoffs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const exchange = await import("./exchange.server");
    return exchange.runBatchHandoff(context.supabase, context.userId);
  });


export const syncExchangeFeedback = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const exchange = await import("./exchange.server");
    const { seen, processed, failed, skipped } = await exchange.runFeedbackSync(context.supabase);
    return { seen, processed, failed, skipped };
  });

