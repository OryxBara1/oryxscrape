/**
 * PISTE / Légifrance API client (server-only).
 *
 * Auth: OAuth2 client_credentials against PISTE, scope `openid`, token lifetime
 * ~3600s. The token is cached in module memory and reused until shortly before
 * expiry. Credentials come from the PISTE_CLIENT_ID / PISTE_CLIENT_SECRET
 * project secrets and are never logged or returned.
 *
 * API base: https://api.piste.gouv.fr/dila/legifrance/lf-engine-app
 *   POST /search              { fond, recherche }
 *   POST /consult/lawDecree   { textId, date }
 */

const OAUTH_URL = "https://oauth.piste.gouv.fr/api/oauth/token";
const API_BASE = "https://api.piste.gouv.fr/dila/legifrance/lf-engine-app";

export const PISTE_COLLECTOR_VERSION = "piste-legifrance-api@1.0.0";

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getPisteToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const clientId = process.env["PISTE_CLIENT_ID"];
  const clientSecret = process.env["PISTE_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    throw new Error("PISTE_CLIENT_ID / PISTE_CLIENT_SECRET are not configured");
  }

  const response = await fetch(OAUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "openid",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`PISTE OAuth failed [${response.status}]: ${bodyText.slice(0, 400)}`);
  }

  const payload = JSON.parse(bodyText) as { access_token?: string; expires_in?: number };
  if (!payload.access_token) {
    throw new Error(`PISTE OAuth returned no access_token: ${bodyText.slice(0, 300)}`);
  }

  cachedToken = {
    value: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

async function piste<T>(path: string, body: unknown): Promise<T> {
  const token = await getPisteToken();
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    // 401 can mean an expired cached token: drop it so the next call re-auths.
    if (response.status === 401) cachedToken = null;
    throw new Error(`Légifrance ${path} failed [${response.status}]: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as T;
}

export type LodaSearchHit = { id: string; cid: string; title: string };

/**
 * Splits a concept query into its synonym phrases. Synonyms of the SAME concept
 * are OR'd inside one query string, e.g. `"permis plaisance" OR "permis bateau"`.
 */
export function parseConceptQuery(query: string): string[] {
  return query
    .split(/\s+OR\s+/i)
    .map((part) => part.trim().replace(/^["«»]+|["«»]+$/g, "").trim())
    .filter((part) => part.length > 0);
}

/**
 * Full-text search over LODA (lois, ordonnances, décrets, arrêtés).
 * All phrases belong to a single concept and are combined with OU.
 */
export async function searchLoda(input: {
  query: string;
  pageSize?: number;
}): Promise<LodaSearchHit[]> {
  const phrases = parseConceptQuery(input.query);
  if (!phrases.length) throw new Error("Empty concept query");

  // Légifrance rejects EXPRESSION_EXACTE / multi-critere OU inside one champ;
  // the accepted OR shape is one champ per synonym phrase joined with OU.
  const champs = phrases.map((phrase) => ({
    typeChamp: "ALL",
    criteres: [
      { typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP", valeur: phrase, operateur: "ET" },
    ],
    operateur: "OU",
  }));

  const result = await piste<{
    results?: { titles?: LodaSearchHit[] }[];
  }>("/search", {
    fond: "LODA_DATE",
    recherche: {
      champs,

      filtres: [{ facette: "DATE_VERSION", singleDate: Date.now() }],
      pageNumber: 1,
      pageSize: input.pageSize ?? 10,
      operateur: "ET",
      sort: "PERTINENCE",
      typePagination: "DEFAUT",
    },
  });

  return (result.results ?? []).flatMap((row) => row.titles ?? []);
}


export type LodaTextArticle = { num?: string | null; content?: string | null };
export type LodaText = {
  id?: string;
  cid?: string;
  title?: string;
  nor?: string | null;
  nature?: string | null;
  dateParution?: string | null;
  sections?: { title?: string | null; articles?: LodaTextArticle[] }[];
  articles?: LodaTextArticle[];
};

/** Consult one LODA text (LEGITEXT…) at a given date (defaults to today). */
export async function consultLawDecree(textId: string, date?: string): Promise<LodaText> {
  const result = await piste<{ text?: LodaText } & LodaText>("/consult/lawDecree", {
    textId,
    date: date ?? new Date().toISOString().slice(0, 10),
  });
  return result.text ?? (result as LodaText);
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Flattens a consulted LODA text into plain text for normalization. */
export function lodaTextToPlainText(text: LodaText): string {
  const parts: string[] = [];
  if (text.title) parts.push(text.title);
  const walk = (articles?: LodaTextArticle[]) => {
    for (const article of articles ?? []) {
      const body = article.content ? stripTags(article.content) : "";
      if (body) parts.push(article.num ? `Article ${article.num}\n${body}` : body);
    }
  };
  walk(text.articles);
  for (const section of text.sections ?? []) {
    if (section.title) parts.push(section.title);
    walk(section.articles);
  }
  return parts.join("\n\n");
}

/** Stable public web URL for a consulted LODA text. */
export function legifranceUrl(textId: string): string {
  return `https://www.legifrance.gouv.fr/loda/id/${textId}`;
}
