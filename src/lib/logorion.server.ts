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
const PROMPT_ID = "d9a1b3f4-6c72-45e8-9b10-2f83c4d75a61";

export type NormalizedDoc = {
  title: string | null;
  jurisdiction_hint: string | null;
  category: string | null;
  document_reference: string | null;
  issued_at: string | null;
  language: string | null;
  summary: string | null;
  body_excerpt: string | null;
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
};

const FIELDS = Object.keys(EMPTY) as (keyof NormalizedDoc)[];

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
  for (const field of FIELDS) {
    const value = parsed[field];
    out[field] = typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  }
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
        variables: {
          source_url: input.sourceUrl,
          content: input.content.slice(0, 12000),
        },
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
