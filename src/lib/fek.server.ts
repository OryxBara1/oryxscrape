/**
 * Greek Government Gazette (Εθνικό Τυπογραφείο / ΦΕΚ) client — server only.
 *
 * search.et.gr is backed by an open, unauthenticated JSON API. PDFs live in a
 * public Azure Blob container under a fully predictable path, so no session,
 * token or crawler is involved. Verified live: no anti-bot protection, modern
 * TLS required, documents from 2000 onward carry a real text layer.
 */

export const FEK_COLLECTOR_VERSION = "etgr-fek-api@1.0.0";

const SEARCH_API = "https://searchetv99.azurewebsites.net/api/simplesearch";
const BLOB_BASE = "https://ia37rg02wpsa01.blob.core.windows.net/fek";

/** Issue ("τεύχος") codes used by the API. We only monitor Series B. */
export const FEK_ISSUE_B = "2";

export type FekEntry = {
  documentNumber: number;
  issue: string;
  year: number;
  issueDate: string | null;
  label: string | null;
  pdfUrl: string;
};

/** `/{issue:02}/{year}/{year}{issue:02}{docnum:05}.pdf` — exact padding matters. */
export function fekPdfUrl(year: number, issue: string, documentNumber: number): string {
  const iss = String(Number(issue)).padStart(2, "0");
  const doc = String(documentNumber).padStart(5, "0");
  return `${BLOB_BASE}/${iss}/${year}/${year}${iss}${doc}.pdf`;
}

type RawHit = {
  search_DocumentNumber?: string;
  search_IssueGroupID?: string;
  search_IssueDate?: string;
  search_PublicationDate?: string;
  search_PrimaryLabel?: string;
};

function parseDate(value?: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Lists gazette issues for a year/series. The API answers with the result
 * array encoded as a JSON string inside `data`.
 */
export async function searchFek(input: {
  year: number;
  issue?: string;
}): Promise<FekEntry[]> {
  const issue = input.issue ?? FEK_ISSUE_B;
  const response = await fetch(SEARCH_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://search.et.gr",
    },
    body: JSON.stringify({
      selectYear: [String(input.year)],
      selectIssue: [issue],
    }),
  });
  if (!response.ok) {
    throw new Error(`et.gr search failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { status?: string; data?: unknown };
  if (body.status !== "ok") throw new Error("et.gr search returned a non-ok status.");

  const raw: RawHit[] =
    typeof body.data === "string" ? JSON.parse(body.data) : ((body.data ?? []) as RawHit[]);

  return raw
    .map((hit) => {
      const documentNumber = Number(hit.search_DocumentNumber);
      if (!Number.isFinite(documentNumber)) return null;
      return {
        documentNumber,
        issue,
        year: input.year,
        issueDate: hit.search_IssueDate ?? hit.search_PublicationDate ?? null,
        label: hit.search_PrimaryLabel ?? null,
        pdfUrl: fekPdfUrl(input.year, issue, documentNumber),
      } satisfies FekEntry;
    })
    .filter((entry): entry is FekEntry => entry !== null);
}

/** The N most recent issues of a series, newest first. */
export async function latestFekIssues(input: {
  year: number;
  issue?: string;
  limit: number;
}): Promise<FekEntry[]> {
  const entries = await searchFek({ year: input.year, issue: input.issue ?? FEK_ISSUE_B });
  return entries
    .sort((a, b) => {
      const byDate = parseDate(b.issueDate) - parseDate(a.issueDate);
      return byDate !== 0 ? byDate : b.documentNumber - a.documentNumber;
    })
    .slice(0, Math.max(1, input.limit));
}
