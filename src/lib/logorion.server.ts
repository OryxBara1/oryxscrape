/**
 * LogoriOn — AI gateway used for normalization (server-only).
 *
 * Turns a messy crawled page into a structured record. Nothing here ever
 * receives or returns credentials; LOVABLE_API_KEY is read per call.
 */

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-flash";

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

const TOOL = {
  type: "function",
  function: {
    name: "emit_normalized_document",
    description: "Return the structured form of an official gazette page.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Official document title" },
        jurisdiction_hint: {
          type: "string",
          description: "Jurisdiction, e.g. 'ES', 'ES-CN', 'EU'",
        },
        category: {
          type: "string",
          description: "Document class, e.g. ley, decreto_legislativo, orden, resolucion, otro",
        },
        document_reference: { type: "string", description: "e.g. 'Ley 14/2003'" },
        issued_at: { type: "string", description: "ISO date (YYYY-MM-DD) when issued" },
        language: { type: "string", description: "ISO 639-1 code" },
        summary: { type: "string", description: "Two-sentence factual summary" },
        body_excerpt: { type: "string", description: "First ~800 chars of the legal text" },
      },
      required: ["title", "category"],
      additionalProperties: false,
    },
  },
} as const;

export async function normalizeWithLogoriOn(input: {
  sourceUrl: string;
  content: string;
}): Promise<NormalizedDoc> {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) throw new Error("LOVABLE_API_KEY is not configured");

  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            "You normalize official gazette pages. Extract only what is present in the page; never invent references, dates or jurisdictions. Leave a field out when the page does not state it. Always call the tool.",
        },
        {
          role: "user",
          content: `Source URL: ${input.sourceUrl}\n\nPage content:\n${input.content.slice(0, 12000)}`,
        },
      ],
      tools: [TOOL],
      tool_choice: { type: "function", function: { name: "emit_normalized_document" } },
    }),
  });

  if (response.status === 429) throw new Error("LogoriOn rate limit reached; retry shortly.");
  if (response.status === 402) throw new Error("LogoriOn credits exhausted for this workspace.");
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LogoriOn request failed [${response.status}]: ${body.slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
  };
  const args = payload.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) return EMPTY;

  try {
    const parsed = JSON.parse(args) as Partial<NormalizedDoc>;
    return { ...EMPTY, ...parsed };
  } catch {
    return EMPTY;
  }
}
