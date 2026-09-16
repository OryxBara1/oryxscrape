// Server-only packaging helpers for the AuraMaris Drive handoff.
import {
  ARTIFACT_KIND,
  CONTENT_INTEGRITY_SCOPE,
  MANIFEST_VERSION,
} from "./exchange-config";

export type NormalizedPayload = Record<string, unknown>;

function pickString(payload: NormalizedPayload, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

export function extractTitle(payload: NormalizedPayload): string | null {
  return pickString(payload, ["title", "document_title", "heading"]);
}

// Artifact text comes from the immutable raw evidence; the normalized payload
// only carries metadata. Falls back to the normalized payload when present.
export function extractArtifactText(
  rawPayload: NormalizedPayload,
  normalizedPayload: NormalizedPayload,
): string {
  const raw = pickString(rawPayload, ["plain_text", "text", "extracted_text", "content", "body"]);
  if (raw) return raw;
  return extractText(normalizedPayload);
}

export function extractText(payload: NormalizedPayload): string {
  const text = pickString(payload, [
    "text",
    "plain_text",
    "extracted_text",
    "content",
    "body",
    "body_excerpt",
    "summary",
  ]);
  if (!text) throw new Error("This item has no extracted text to package.");
  return text;
}

export function extractReference(payload: NormalizedPayload): string | null {
  return pickString(payload, ["reference", "identifier", "document_reference", "eli"]);
}

export function extractPublicationDate(payload: NormalizedPayload): string | null {
  return pickString(payload, ["publication_date", "issued_at", "date", "published_at"]);
}

export function extractConcept(payload: NormalizedPayload): {
  code: string | null;
  label: string | null;
} {
  return {
    code: pickString(payload, ["concept_code", "conceptCode", "concept_query"]),
    label: pickString(payload, ["concept_label", "conceptLabel"]),
  };
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function byteLength(input: string): number {
  return new TextEncoder().encode(input).length;
}

export type ManifestInput = {
  exchangeItemId: string;
  sourceUrl: string;
  canonicalUrl: string | null;
  countryCode: string;
  languageCode: string;
  title: string | null;
  reference: string | null;
  publicationDate: string | null;
  category: string | null;
  jurisdictionHint: string | null;
  conceptCode: string | null;
  conceptLabel: string | null;
  collectedAt: string;
  artifactFilename: string;
  artifactSha256: string;
  artifactSizeBytes: number;
  artifactMimeType: string;
};

// Deliberately excludes tiers, policies, profiles, reviewers, prompts,
// credentials, provider metadata and raw payloads.
export function buildManifest(input: ManifestInput) {
  return {
    manifest_version: MANIFEST_VERSION,
    exchange_item_id: input.exchangeItemId,
    document: {
      title: input.title,
      reference: input.reference,
      publication_date: input.publicationDate,
      category: input.category,
      jurisdiction_hint: input.jurisdictionHint,
      country_code: input.countryCode,
      language_code: input.languageCode,
      source_url: input.sourceUrl,
      canonical_url: input.canonicalUrl,
      collected_at: input.collectedAt,
    },
    provenance: {
      concept_code: input.conceptCode,
      concept_label: input.conceptLabel,
    },
    artifact: {
      filename: input.artifactFilename,
      mime_type: input.artifactMimeType,
      size_bytes: input.artifactSizeBytes,
      sha256: input.artifactSha256,
      artifact_kind: ARTIFACT_KIND,
      original_artifact_available: false,
      content_integrity_scope: CONTENT_INTEGRITY_SCOPE,
    },
    handoff: {
      oryx_verification_status: "reviewed",
      oryx_publication_status: "eligible_for_handoff",
      do_not_auto_import: true,
      official_artifact_verified: false,
      automation_eligible: false,
    },
  };
}

export const FEEDBACK_DECISIONS = [
  "accepted",
  "rejected",
  "duplicate",
  "superseded",
] as const;

export type FeedbackDecision = (typeof FEEDBACK_DECISIONS)[number];

// Every decision other than "accepted" means AuraMaris will not take this exact
// artifact — each keeps its own distinguishable state and suppression label.
export const NEGATIVE_DECISIONS: readonly FeedbackDecision[] = [
  "rejected",
  "duplicate",
  "superseded",
];

export type ExchangeFeedback = {
  exchange_item_id: string;
  decision: FeedbackDecision;
  decided_at?: string | undefined;
  reason_code?: string | undefined;
  reason_detail?: string | undefined;
  artifact_sha256?: string | undefined;
  auramaris_document_ref?: string | undefined;
};

export function parseFeedback(raw: string): ExchangeFeedback {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("Feedback file is not valid JSON.");
  }
  const obj = json as Record<string, unknown>;
  const id = obj["exchange_item_id"];
  const decision = obj["decision"];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof id !== "string" || !uuid.test(id)) {
    throw new Error("Feedback is missing a valid exchange_item_id.");
  }
  if (!FEEDBACK_DECISIONS.includes(decision as FeedbackDecision)) {
    throw new Error(
      `Feedback decision must be one of ${FEEDBACK_DECISIONS.join(", ")}.`,
    );
  }
  const str = (key: string) => {
    const value = obj[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  return {
    exchange_item_id: id,
    decision: decision as FeedbackDecision,
    decided_at: str("decided_at"),
    reason_code: str("reason_code"),
    reason_detail: str("reason_detail"),
    artifact_sha256: str("artifact_sha256"),
    auramaris_document_ref:
      str("auramaris_document_ref") ?? str("auramaris_document_id") ?? str("document_ref"),
  };
}

export function buildAck(params: {
  exchangeItemId: string | null;
  feedbackFileId: string;
  feedbackFileName: string;
  status: "processed" | "failed";
  detail?: string | undefined;
}) {
  return {
    ack_version: MANIFEST_VERSION,
    exchange_item_id: params.exchangeItemId,
    feedback_file_id: params.feedbackFileId,
    feedback_file_name: params.feedbackFileName,
    status: params.status,
    detail: params.detail ?? null,
    acknowledged_at: new Date().toISOString(),
    acknowledged_by: "oryxscrape",
  };
}

// ---------------------------------------------------------------------------
// Shared packaging + send pipeline (used by the Exchange screen and batch runs).
// ---------------------------------------------------------------------------

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type ExchangeDb = SupabaseClient<Database>;

export type SendResult = {
  exchangeItemId: string;
  driveFolderId: string;
  driveArtifactFileId: string;
  driveMetadataFileId: string;
};

export async function packageAndSend(
  supabase: ExchangeDb,
  userId: string | null,
  input: { normalizedItemId: string; countryCode: string; languageCode: string },
): Promise<SendResult> {
  const drive = await import("./drive.server");
  const { EXCHANGE_FOLDERS } = await import("./exchange-config");

  const { data: item, error } = await supabase
    .from("normalized_items")
    .select(
      "id, source_url, jurisdiction_hint, category, payload, collected_at, verification_status, publication_status, raw_item_id",
    )
    .eq("id", input.normalizedItemId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!item) throw new Error("Item not found.");
  if (item.verification_status !== "reviewed" || item.publication_status !== "eligible") {
    throw new Error("Only reviewed items marked eligible for external handoff can be packaged.");
  }

  const { data: raw } = await supabase
    .from("raw_items")
    .select("canonical_url, raw_payload")
    .eq("id", item.raw_item_id)
    .maybeSingle();

  const payload = (item.payload ?? {}) as Record<string, unknown>;
  const text = extractArtifactText((raw?.raw_payload ?? {}) as Record<string, unknown>, payload);
  const artifactSha256 = await sha256Hex(text);

  const { data: blocked } = await supabase
    .from("exchange_suppressions")
    .select("id, reason_code")
    .eq("rule_kind", "sha256")
    .eq("match_value", artifactSha256)
    .eq("strength", "hard_skip")
    .eq("is_active", true)
    .maybeSingle();
  if (blocked) {
    throw new Error("This exact artifact was previously rejected by AuraMaris and is suppressed.");
  }

  const { data: existing } = await supabase
    .from("exchange_handoffs")
    .select(
      "id, exchange_item_id, drive_folder_id, drive_artifact_file_id, drive_metadata_file_id, state",
    )
    .eq("normalized_item_id", item.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing && existing.state !== "error") {
    throw new Error("This item has already been handed off.");
  }

  const artifactFilename = "artifact.txt";
  const artifactMimeType = "text/plain; charset=utf-8";
  const artifactSizeBytes = byteLength(text);

  let row = existing;
  if (!row) {
    const { data: inserted, error: insertError } = await supabase
      .from("exchange_handoffs")
      .insert({
        normalized_item_id: item.id,
        artifact_sha256: artifactSha256,
        artifact_filename: artifactFilename,
        artifact_mime_type: artifactMimeType,
        artifact_size_bytes: artifactSizeBytes,
        country_code: input.countryCode,
        language_code: input.languageCode,
        state: "pending",
        created_by: userId,
      })
      .select(
        "id, exchange_item_id, drive_folder_id, drive_artifact_file_id, drive_metadata_file_id, state",
      )
      .single();
    if (insertError) throw new Error(insertError.message);
    row = inserted;
  }

  const concept = extractConcept(payload);
  const manifest = buildManifest({
    exchangeItemId: row.exchange_item_id,
    sourceUrl: item.source_url,
    canonicalUrl: raw?.canonical_url ?? null,
    countryCode: input.countryCode,
    languageCode: input.languageCode,
    title: extractTitle(payload),
    reference: extractReference(payload),
    publicationDate: extractPublicationDate(payload),
    category: item.category,
    jurisdictionHint: item.jurisdiction_hint,
    conceptCode: concept.code,
    conceptLabel: concept.label,
    collectedAt: item.collected_at,
    artifactFilename,
    artifactSha256,
    artifactSizeBytes,
    artifactMimeType,
  });

  try {
    const folderId =
      row.drive_folder_id ??
      (await drive.createFolder(row.exchange_item_id, EXCHANGE_FOLDERS.pendingReview)).id;

    const artifactFile = row.drive_artifact_file_id
      ? { id: row.drive_artifact_file_id }
      : await drive.uploadTextFile({
          name: artifactFilename,
          parentId: folderId,
          mimeType: "text/plain",
          content: text,
        });

    const metadataFile = row.drive_metadata_file_id
      ? { id: row.drive_metadata_file_id }
      : await drive.uploadTextFile({
          name: "metadata.json",
          parentId: folderId,
          mimeType: "application/json",
          content: JSON.stringify(manifest, null, 2),
        });

    const { error: updateError } = await supabase
      .from("exchange_handoffs")
      .update({
        drive_folder_id: folderId,
        drive_artifact_file_id: artifactFile.id,
        drive_metadata_file_id: metadataFile.id,
        state: "pending",
        sent_at: new Date().toISOString(),
        artifact_sha256: artifactSha256,
        artifact_size_bytes: artifactSizeBytes,
        country_code: input.countryCode,
        language_code: input.languageCode,
        error_reason: null,
      })
      .eq("id", row.id);
    if (updateError) throw new Error(updateError.message);

    return {
      exchangeItemId: row.exchange_item_id,
      driveFolderId: folderId,
      driveArtifactFileId: artifactFile.id,
      driveMetadataFileId: metadataFile.id,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from("exchange_handoffs")
      .update({ state: "error", error_reason: message })
      .eq("id", row.id);
    throw new Error(message);
  }
}

// Fixed per-source country/language mapping for batch handoffs.
export function deriveLocaleFromSourceName(
  name: string,
): { countryCode: string; languageCode: string } | null {
  const n = name.toLowerCase();
  if (n.includes("boe")) return { countryCode: "ES", languageCode: "es" };
  if (n.includes("légifrance") || n.includes("legifrance"))
    return { countryCode: "FR", languageCode: "fr" };
  if (n.includes("narodne novine")) return { countryCode: "HR", languageCode: "hr" };
  if (n.includes("gesetze im internet")) return { countryCode: "DE", languageCode: "de" };
  return null;
}

export type BatchRow = {
  normalizedItemId: string;
  source: string;
  exchangeItemId: string | null;
  countryCode: string | null;
  languageCode: string | null;
  result: "sent" | "error" | "skipped-suppressed" | "skipped-unknown-source";
  detail?: string;
};

export async function runBatchHandoff(supabase: ExchangeDb, userId: string | null) {
  const { data: items, error } = await supabase
    .from("normalized_items")
    .select("id, source_id, sources(name)")
    .eq("verification_status", "reviewed")
    .eq("publication_status", "eligible")
    .order("updated_at", { ascending: true });
  if (error) throw new Error(error.message);

  const { data: handoffs } = await supabase
    .from("exchange_handoffs")
    .select("normalized_item_id, state");
  const taken = new Set(
    (handoffs ?? []).filter((h) => h.state !== "error").map((h) => h.normalized_item_id),
  );

  const rows: BatchRow[] = [];
  for (const item of items ?? []) {
    if (taken.has(item.id)) continue;
    const src = item.sources as unknown as { name: string } | null;
    const sourceName = src?.name ?? "";
    const locale = deriveLocaleFromSourceName(sourceName);
    if (!locale) {
      rows.push({
        normalizedItemId: item.id,
        source: sourceName,
        exchangeItemId: null,
        countryCode: null,
        languageCode: null,
        result: "skipped-unknown-source",
      });
      continue;
    }
    try {
      const sent = await packageAndSend(supabase, userId, {
        normalizedItemId: item.id,
        ...locale,
      });
      rows.push({
        normalizedItemId: item.id,
        source: sourceName,
        exchangeItemId: sent.exchangeItemId,
        countryCode: locale.countryCode,
        languageCode: locale.languageCode,
        result: "sent",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const suppressed = message.includes("suppressed");
      const { data: row } = await supabase
        .from("exchange_handoffs")
        .select("exchange_item_id")
        .eq("normalized_item_id", item.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      rows.push({
        normalizedItemId: item.id,
        source: sourceName,
        exchangeItemId: row?.exchange_item_id ?? null,
        countryCode: locale.countryCode,
        languageCode: locale.languageCode,
        result: suppressed ? "skipped-suppressed" : "error",
        detail: message,
      });
    }
  }

  return { total: rows.length, sent: rows.filter((r) => r.result === "sent").length, rows };
}
