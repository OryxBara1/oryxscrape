// Non-sensitive Google Shared Drive configuration for the OryxScrape ↔ AuraMaris exchange.
// These are IDs only — no credentials. Credentials come from the linked Drive connector.

export const EXCHANGE_SHARED_DRIVE_ID = "0AOesw6uCeLquUk9PVA";

export const EXCHANGE_FOLDERS = {
  pendingReview: "1mTL8uCeCeVk7ea1M_mW3Zy1-i3gNalbi", // 01_Pending_Review  (OryxScrape writes)
  accepted: "1neUSalxkeJ27AP_pyg5R0VZN8PcmQLiv", // 02_Accepted        (AuraMaris only — never written by us)
  rejected: "19cl6vEescHgSui8tYk50B5WP6HFd_zgu", // 03_Rejected        (AuraMaris only — never written by us)
  rejectionFeedback: "1JXhXcBtZPYEAbOSp3j1nXdNjqLfEAbyJ", // 04_Rejection_Feedback (we read feedback, write acks)
  searchTermsShared: "1vkY03W1TWkAsDYIvAYLte3BKz79Ft3Qk", // 05_Search_Terms_Shared (we write exports)
} as const;

// Archive for item folders staff has confirmed as seen in AuraMaris. It lives
// inside 01_Pending_Review because that is the only intake folder we may write
// to; "_processed" is our bookkeeping, never an AuraMaris decision.
export const PROCESSED_FOLDER_NAME = "_processed";


// Folders this identity is allowed to write to. 02/03 are deliberately excluded.
export const WRITABLE_FOLDER_IDS: readonly string[] = [
  EXCHANGE_FOLDERS.pendingReview,
  EXCHANGE_FOLDERS.rejectionFeedback,
  EXCHANGE_FOLDERS.searchTermsShared,
];

// Each source publishes for exactly one jurisdiction, so country/language can be
// suggested from the source. "EU" is reserved for EU-level instruments collected
// directly (not national transpositions).
type Locale = { countryCode: string; languageCode: string };

const DOMAIN_LOCALES: Array<[string, Locale]> = [
  ["boe.es", { countryCode: "ES", languageCode: "es" }],
  ["legifrance.gouv.fr", { countryCode: "FR", languageCode: "fr" }],
  ["piste.gouv.fr", { countryCode: "FR", languageCode: "fr" }],
  ["nn.hr", { countryCode: "HR", languageCode: "hr" }],
  ["narodne-novine.nn.hr", { countryCode: "HR", languageCode: "hr" }],
  ["gesetze-im-internet.de", { countryCode: "DE", languageCode: "de" }],
  ["guardiacostiera.gov.it", { countryCode: "IT", languageCode: "it" }],
  ["gazzettaufficiale.it", { countryCode: "IT", languageCode: "it" }],
  ["diariodarepublica.pt", { countryCode: "PT", languageCode: "pt" }],
  ["dre.pt", { countryCode: "PT", languageCode: "pt" }],
  ["wetten.overheid.nl", { countryCode: "NL", languageCode: "nl" }],
  ["overheid.nl", { countryCode: "NL", languageCode: "nl" }],
  ["officielebekendmakingen.nl", { countryCode: "NL", languageCode: "nl" }],
  ["dou.gov.br", { countryCode: "BR", languageCode: "pt" }],
  ["in.gov.br", { countryCode: "BR", languageCode: "pt" }],
  ["legislation.mt", { countryCode: "MT", languageCode: "en" }],
  ["cylaw.org", { countryCode: "CY", languageCode: "el" }],
  ["et.gr", { countryCode: "GR", languageCode: "el" }],
  ["europa.eu", { countryCode: "EU", languageCode: "en" }],
];

const NAME_LOCALES: Array<[string, Locale]> = [
  ["boe", { countryCode: "ES", languageCode: "es" }],
  ["légifrance", { countryCode: "FR", languageCode: "fr" }],
  ["legifrance", { countryCode: "FR", languageCode: "fr" }],
  ["narodne novine", { countryCode: "HR", languageCode: "hr" }],
  ["gesetze im internet", { countryCode: "DE", languageCode: "de" }],
  ["guardia costiera", { countryCode: "IT", languageCode: "it" }],
  ["diário da república", { countryCode: "PT", languageCode: "pt" }],
  ["diario da republica", { countryCode: "PT", languageCode: "pt" }],
  ["wetten", { countryCode: "NL", languageCode: "nl" }],
  ["legislation.mt", { countryCode: "MT", languageCode: "en" }],
  ["malta", { countryCode: "MT", languageCode: "en" }],
  ["cylaw", { countryCode: "CY", languageCode: "el" }],
  ["cyprus", { countryCode: "CY", languageCode: "el" }],
  ["et.gr", { countryCode: "GR", languageCode: "el" }],
  ["εφημερίδα", { countryCode: "GR", languageCode: "el" }],
  ["eur-lex", { countryCode: "EU", languageCode: "en" }],
];

export function suggestLocale(input: {
  sourceName?: string | null;
  sourceDomain?: string | null;
  sourceUrl?: string | null;
}): Locale | null {
  // Match on host suffix, never on a raw substring: a path or query containing
  // "et.gr" or "europa.eu" must not decide the jurisdiction of another country.
  const hosts: string[] = [];
  const domain = (input.sourceDomain ?? "").trim().toLowerCase();
  if (domain) hosts.push(domain.replace(/^https?:\/\//, "").split("/")[0] ?? domain);
  if (input.sourceUrl) {
    try {
      hosts.push(new URL(input.sourceUrl).hostname.toLowerCase());
    } catch {
      /* not a parseable URL — the domain column is enough */
    }
  }
  for (const [candidate, locale] of DOMAIN_LOCALES) {
    if (hosts.some((host) => host === candidate || host.endsWith(`.${candidate}`))) return locale;
  }
  const name = (input.sourceName ?? "").toLowerCase();
  for (const [key, locale] of NAME_LOCALES) {
    if (name.includes(key)) return locale;
  }
  return null;
}

export const ARTIFACT_KIND = "extracted_text_only";
export const CONTENT_INTEGRITY_SCOPE = "normalized_extracted_text";
export const MANIFEST_VERSION = "1.0";
