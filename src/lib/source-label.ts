// Display-only labels for source pickers: "Country — Source Name", sorted by country then name.
// The sources table has no jurisdiction column, so the country comes from the domain.

const COUNTRY_NAMES: Record<string, string> = {
  MT: "Malta", IT: "Italy", GB: "United Kingdom", UK: "United Kingdom", PT: "Portugal",
  DE: "Germany", FR: "France", NL: "Netherlands", HR: "Croatia", BR: "Brazil", ES: "Spain",
  GI: "Gibraltar", GR: "Greece", CY: "Cyprus", TR: "Turkey", TN: "Tunisia", IS: "Iceland",
  LT: "Lithuania", LV: "Latvia", MA: "Morocco", NO: "Norway", DK: "Denmark", FI: "Finland",
  EE: "Estonia", SE: "Sweden", EU: "European Union",
};

// Extra spellings that appear inside existing source names.
const COUNTRY_ALIASES: Record<string, string> = {
  grécia: "GR", alemanha: "DE", brasil: "BR", espanha: "ES", itália: "IT",
};

const DOMAIN_OVERRIDES: Array<[RegExp, string]> = [
  [/gibraltarport\.com$/i, "GI"],
  [/cylaw\.org$/i, "CY"],
  [/europa\.eu$/i, "EU"],
];

export function sourceCountryCode(domain: string | null | undefined): string | null {
  const d = (domain ?? "").trim().toLowerCase();
  if (!d) return null;
  for (const [re, code] of DOMAIN_OVERRIDES) if (re.test(d)) return code;
  const tld = d.split(".").pop() ?? "";
  if (tld.length === 2) return tld.toUpperCase();
  return null;
}

export function countryName(code: string | null): string {
  if (!code) return "Unknown";
  return COUNTRY_NAMES[code] ?? code;
}

function isCountryText(text: string, code: string | null): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (code && t === code.toLowerCase()) return true;
  if (Object.values(COUNTRY_NAMES).some((n) => n.toLowerCase() === t)) return true;
  return t in COUNTRY_ALIASES;
}

export function cleanSourceName(name: string, code: string | null): string {
  const parts = name
    .split(/\s+—\s+/)
    .map((p) => p.replace(/\s*\(([^)]*)\)\s*$/, (m, inner: string) => (isCountryText(inner, code) ? "" : m)).trim())
    .filter((p) => p && !isCountryText(p, code));
  return parts.join(" ") || name;
}

export function sourceLabel(source: { name: string; domain?: string | null }): string {
  const code = sourceCountryCode(source.domain);
  return `${countryName(code)} — ${cleanSourceName(source.name, code)}`;
}

export function sortSourcesForPicker<T extends { name: string; domain?: string | null }>(sources: T[]): T[] {
  return [...sources].sort((a, b) => {
    const ca = countryName(sourceCountryCode(a.domain));
    const cb = countryName(sourceCountryCode(b.domain));
    const byCountry = ca.localeCompare(cb, undefined, { sensitivity: "base" });
    if (byCountry !== 0) return byCountry;
    return cleanSourceName(a.name, sourceCountryCode(a.domain)).localeCompare(
      cleanSourceName(b.name, sourceCountryCode(b.domain)),
      undefined,
      { sensitivity: "base" },
    );
  });
}
