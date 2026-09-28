/**
 * LogoriOn — real platform gateway used for normalization (server-only).
 *
 * Contract (docs/gateway/sdk-quickstart.md, integration-reference.md):
 *   POST https://logorion.feetech.online/api/public/gateway/execute
 *   Authorization: Bearer <LOGORION_INTEGRATION_KEY>
 *   body: { prompt_id, variables }
 *   success: { ok: true, result: { text, ... }, usage: { model, provider } }
 *   failure: { ok: false, error: { code, message } } — upstream provider failure = HTTP 502
 *
 * Prompt instructions live in the LogoriOn template (oryxscrape_document_normalize_v1);
 * we only send document content/context. Never collapses to an empty document: any
 * transport, contract or parsing failure throws so the collection job records it.
 */

const GATEWAY_URL = "https://logorion.feetech.online/api/public/gateway/execute";
const PROMPT_ID = "50febfcf-ae9d-4443-a0d5-cbafe937722f"; // oryxscrape_document_normalize_v2
const CAPY_PROMPT_ID = "37c71bdc-5a3f-4b65-b9c6-8472c80ea25d"; // oryxscrape_review_copilot_v1

export type NormalizedDoc = {
  title: string | null;
  jurisdiction_hint: string | null;
  category: string | null;
  document_reference: string | null;
  issued_at: string | null;
  language: string | null;
  summary: string | null;
  body_excerpt: string | null;
  suggested_tags: string[];
  relevance_score: number | null;
};

const EMPTY: NormalizedDoc = {
  title: null,
  jurisdiction_hint: null,
  category: null,
  document_reference: null,
  issued_at: null,
  language: null,
  summary: null,
  body_excerpt: null,
  suggested_tags: [],
  relevance_score: null,
};

const STRING_FIELDS = [
  "title",
  "jurisdiction_hint",
  "category",
  "document_reference",
  "issued_at",
  "language",
  "summary",
  "body_excerpt",
] as const;

/** Pulls the JSON object out of the template's text output (may be fenced). */
function parseResultText(text: string): Partial<NormalizedDoc> {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`LogoriOn returned no JSON document: ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  const out: Partial<NormalizedDoc> = {};
  for (const field of STRING_FIELDS) {
    const value = parsed[field];
    out[field] = typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  }
  const tags = parsed["suggested_tags"];
  out.suggested_tags = Array.isArray(tags)
    ? tags
        .filter((t): t is string => typeof t === "string" && t.trim() !== "")
        .map((t) => t.trim().toLowerCase())
        .slice(0, 8)
    : [];
  const score = Number(parsed["relevance_score"]);
  out.relevance_score =
    parsed["relevance_score"] != null && Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : null;
  return out;
}

export async function normalizeWithLogoriOn(input: {
  sourceUrl: string;
  content: string;
}): Promise<NormalizedDoc> {
  const apiKey = process.env["LOGORION_INTEGRATION_KEY"];
  if (!apiKey) throw new Error("LOGORION_INTEGRATION_KEY is not configured");

  let response: Response;
  try {
    response = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        prompt_id: PROMPT_ID,
        feature_tag: "oryxscrape.document_normalize",
        prompt: input.content.slice(0, 64000),
        metadata: { source_url: input.sourceUrl },
      }),
    });
  } catch (error) {
    throw new Error(`LogoriOn gateway unreachable: ${(error as Error).message}`);
  }

  const bodyText = await response.text();
  let payload: {
    ok?: boolean;
    result?: { text?: string };
    error?: { code?: string; message?: string };
    usage?: { model?: string; provider?: string };
  } | null = null;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    payload = null;
  }

  if (!response.ok || payload?.ok === false) {
    const code = payload?.error?.code ?? String(response.status);
    const message = payload?.error?.message ?? bodyText.slice(0, 300);
    if (response.status === 502) {
      throw new Error(`LogoriOn upstream provider failed [${code}]: ${message}`);
    }
    throw new Error(`LogoriOn request failed [${response.status}/${code}]: ${message}`);
  }

  const text = payload?.result?.text;
  if (!payload?.ok || typeof text !== "string" || text.trim() === "") {
    throw new Error(`LogoriOn returned no result text: ${bodyText.slice(0, 300)}`);
  }

  const doc = { ...EMPTY, ...parseResultText(text) };
  if (!doc.title && !doc.category) {
    throw new Error("LogoriOn returned an empty normalization (no title and no category).");
  }
  console.log(
    `[logorion] normalized ${input.sourceUrl} via ${payload.usage?.provider ?? "?"}/${payload.usage?.model ?? "?"}`,
  );
  return doc;
}

/** Capy review copilot — advisory only; never changes item state. */
export async function askCapyCopilot(input: { document: string; question: string }): Promise<string> {
  const apiKey = process.env["LOGORION_INTEGRATION_KEY"];
  if (!apiKey) throw new Error("LOGORION_INTEGRATION_KEY is not configured");
  const prompt = `DOCUMENTO:\n${input.document.slice(0, 56000)}\n\nDÚVIDA DO REVISOR:\n${input.question.slice(0, 2000)}`;
  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      prompt_id: CAPY_PROMPT_ID,
      feature_tag: "oryxscrape.review_copilot",
      prompt,
    }),
  });
  const bodyText = await response.text();
  let payload: { ok?: boolean; output?: string; result?: { text?: string }; error?: { code?: string; message?: string } } | null = null;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.ok === false) {
    const code = payload?.error?.code ?? String(response.status);
    throw new Error(`Capy indisponível [${response.status}/${code}]: ${payload?.error?.message ?? bodyText.slice(0, 200)}`);
  }
  const text = payload?.result?.text ?? payload?.output;
  if (typeof text !== "string" || text.trim() === "") throw new Error("Capy não retornou resposta.");
  return text.trim();
}
