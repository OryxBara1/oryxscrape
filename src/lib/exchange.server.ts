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

export function extractText(payload: NormalizedPayload): string {
  const text = pickString(payload, [
    "text",
    "plain_text",
    "extracted_text",
    "content",
    "body",
    "summary",
  ]);
  if (!text) throw new Error("This item has no extracted text to package.");
  return text;
}

export function extractReference(payload: NormalizedPayload): string | null {
  return pickString(payload, ["reference", "identifier", "document_reference", "eli"]);
}

export function extractPublicationDate(payload: NormalizedPayload): string | null {
  return pickString(payload, ["publication_date", "date", "published_at"]);
}

export function extractConcept(payload: NormalizedPayload): {
  code: string | null;
  label: string | null;
} {
  return {
    code: pickString(payload, ["concept_code", "conceptCode"]),
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

export type ExchangeFeedback = {
  exchange_item_id: string;
  decision: "accepted" | "rejected";
  decided_at?: string;
  reason_code?: string;
  reason_detail?: string;
  artifact_sha256?: string;
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
  if (decision !== "accepted" && decision !== "rejected") {
    throw new Error("Feedback decision must be 'accepted' or 'rejected'.");
  }
  const str = (key: string) => {
    const value = obj[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  return {
    exchange_item_id: id,
    decision,
    decided_at: str("decided_at"),
    reason_code: str("reason_code"),
    reason_detail: str("reason_detail"),
    artifact_sha256: str("artifact_sha256"),
  };
}

export function buildAck(params: {
  exchangeItemId: string | null;
  feedbackFileId: string;
  feedbackFileName: string;
  status: "processed" | "failed";
  detail?: string;
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
