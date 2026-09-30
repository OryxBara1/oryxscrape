/**
 * Picks the best available body text from a raw payload object.
 * Tries keys in order: plain_text, text, extracted_text, markdown, content, body.
 * Returns the first non-empty trimmed string, or null.
 */
export function pickBodyText(
  rawPayload: Record<string, unknown> | null | undefined,
): string | null {
  if (!rawPayload || typeof rawPayload !== "object") return null;
  const keys = ["plain_text", "text", "extracted_text", "markdown", "content", "body"] as const;
  for (const key of keys) {
    const val = rawPayload[key];
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

/**
 * Maps a collection_method string to a human-readable content_source label.
 */
export function contentSourceFor(collectionMethod: string | null | undefined): string {
  switch (collectionMethod) {
    case "manual":
      return "manual_upload";
    case "parallel_extract":
      return "parallel";
    case "apify":
      return "apify";
    case "http":
      return "direct_http";
    case "api":
      return "official_api";
    default:
      return collectionMethod ?? "unknown";
  }
}
