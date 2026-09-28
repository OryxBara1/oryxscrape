// Canonical jurisdiction codes: maps free-text country names from the model to ISO-like codes.

const ALIASES: Record<string, string> = {
  france: "FR", "french republic": "FR", "republique francaise": "FR", "république française": "FR",
  spain: "ES", "espana": "ES", "españa": "ES", "reino de espana": "ES", "reino de españa": "ES", "kingdom of spain": "ES",
  italy: "IT", italia: "IT", "repubblica italiana": "IT",
  croatia: "HR", hrvatska: "HR", "republika hrvatska": "HR",
  portugal: "PT", "república portuguesa": "PT", "republica portuguesa": "PT",
  greece: "GR", "ελλάδα": "GR", hellas: "GR", el: "GR",
  malta: "MT", cyprus: "CY", "κύπρος": "CY",
  netherlands: "NL", nederland: "NL", "the netherlands": "NL",
  germany: "DE", deutschland: "DE",
  "united kingdom": "UK", gb: "UK", "great britain": "UK",
  brazil: "BR", brasil: "BR",
  turkey: "TR", "türkiye": "TR", tunisia: "TN",
  "european union": "EU", "união europeia": "EU", "union européenne": "EU",
};

const DOMAIN_HINTS: Array<[RegExp, string]> = [
  [/legifrance\.gouv\.fr|\.gouv\.fr/i, "FR"],
  [/boe\.es/i, "ES"],
  [/normattiva\.it|gazzettaufficiale\.it/i, "IT"],
  [/narodne-novine\.nn\.hr|\.hr\//i, "HR"],
  [/eur-lex\.europa\.eu/i, "EU"],
  [/legislation\.gov\.uk/i, "UK"],
  [/overheid\.nl/i, "NL"],
  [/in\.gov\.br/i, "BR"],
];

export function canonicalJurisdiction(value: string | null | undefined, sourceUrl?: string): string | null {
  const v = (value ?? "").trim();
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase() === "GB" ? "UK" : v.toUpperCase();
  const alias = ALIASES[v.toLowerCase()];
  if (alias) return alias;
  if (sourceUrl) for (const [re, code] of DOMAIN_HINTS) if (re.test(sourceUrl)) return code;
  return v || null;
}
