import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listHandoffCandidates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: items, error } = await context.supabase
      .from("normalized_items")
      .select(
        "id, source_url, jurisdiction_hint, category, payload, collected_at, updated_at",
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
      return {
        id: item.id,
        sourceUrl: item.source_url,
        title,
        category: item.category,
        jurisdictionHint: item.jurisdiction_hint,
        collectedAt: item.collected_at,
        alreadySent: taken.has(item.id),
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
    const { supabase } = context;
    const exchange = await import("./exchange.server");
    const drive = await import("./drive.server");
    const { EXCHANGE_FOLDERS, EXCHANGE_SHARED_DRIVE_ID } = await import("./exchange-config");

    const files = await drive.listFolderInDrive(
      EXCHANGE_FOLDERS.rejectionFeedback,
      EXCHANGE_SHARED_DRIVE_ID,
    );
    const feedbackFiles = files.filter(
      (f) => f.name.endsWith(".json") && !f.name.endsWith(".ack.json"),
    );

    let processed = 0;
    let failed = 0;
    let skipped = 0;

    for (const file of feedbackFiles) {
      const { data: seen } = await supabase
        .from("exchange_handoffs")
        .select("id")
        .eq("drive_feedback_file_id", file.id)
        .maybeSingle();
      if (seen) {
        skipped += 1;
        continue;
      }

      let ackStatus: "processed" | "failed" = "processed";
      let ackDetail: string | undefined;
      let exchangeItemId: string | null = null;

      try {
        const feedback = exchange.parseFeedback(await drive.getFileText(file.id));
        exchangeItemId = feedback.exchange_item_id;

        const { data: handoff } = await supabase
          .from("exchange_handoffs")
          .select("id, artifact_sha256")
          .eq("exchange_item_id", feedback.exchange_item_id)
          .maybeSingle();
        if (!handoff) throw new Error("Unknown exchange_item_id.");

        await supabase
          .from("exchange_handoffs")
          .update({
            state: feedback.decision === "accepted" ? "accepted" : "rejected",
            auramaris_decision: feedback.decision,
            auramaris_decision_at: feedback.decided_at ?? new Date().toISOString(),
            reason_code: feedback.reason_code ?? null,
            reason_detail: feedback.reason_detail ?? null,
            drive_feedback_file_id: file.id,
            last_synced_at: new Date().toISOString(),
          })
          .eq("id", handoff.id);

        if (feedback.decision === "rejected") {
          await supabase.from("exchange_suppressions").insert({
            exchange_item_id: feedback.exchange_item_id,
            rule_kind: "sha256",
            match_value: feedback.artifact_sha256 ?? handoff.artifact_sha256,
            strength: "hard_skip",
            reason_code: feedback.reason_code ?? null,
            reason_detail: feedback.reason_detail ?? null,
          });
        }
        processed += 1;
      } catch (err) {
        ackStatus = "failed";
        ackDetail = err instanceof Error ? err.message : String(err);
        failed += 1;
        if (exchangeItemId) {
          await supabase
            .from("exchange_handoffs")
            .update({ state: "error", error_reason: ackDetail, last_synced_at: new Date().toISOString() })
            .eq("exchange_item_id", exchangeItemId);
        }
      }

      const ack = exchange.buildAck({
        exchangeItemId,
        feedbackFileId: file.id,
        feedbackFileName: file.name,
        status: ackStatus,
        detail: ackDetail,
      });
      const ackFile = await drive.uploadTextFile({
        name: `${file.name.replace(/\.json$/, "")}.ack.json`,
        parentId: EXCHANGE_FOLDERS.rejectionFeedback,
        mimeType: "application/json",
        content: JSON.stringify(ack, null, 2),
      });
      if (ackStatus === "processed" && exchangeItemId) {
        await supabase
          .from("exchange_handoffs")
          .update({ drive_ack_file_id: ackFile.id })
          .eq("exchange_item_id", exchangeItemId);
      }
    }

    return { seen: feedbackFiles.length, processed, failed, skipped };
  });
