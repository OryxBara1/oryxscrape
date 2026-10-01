// Display-only labels for every source picker: "Country — Source Name", sorted by label.
// sources has no jurisdiction column today; when jurisdiction_hint is absent the
// country code is derived from the domain's country TLD (plus a few known overrides).

const COUNTRY_NAMES: Record<string, string> = {
  BR: "Brazil", HR: "Croatia", CY: "Cyprus", DK: "Denmark",
  EU: "European Union", FR: "France", DE: "Germany", GI: "Gibraltar",
  GR: "Greece", IT: "Italy", MT: "Malta", MA: "Morocco",
  NL: "Netherlands", PT: "Portugal", ES: "Spain", TN: "Tunisia",
  TR: "Turkey", GB: "United Kingdom",
};

const DOMAIN_OVERRIDES: Array<[RegExp, string]> = [
  [/gibraltarport\.com$/i, "GI"],
  [/cylaw\.org$/i, "CY"],
  [/europa\.eu$/i, "EU"],
  [/\.uk$/i, "GB"],
];

type LabelSource = { name: string; jurisdiction_hint?: string | null; domain?: string | null };

function countryCode(source: LabelSource): string {
  const hint = source.jurisdiction_hint?.trim().toUpperCase();
  if (hint) return hint === "UK" ? "GB" : hint;
  const d = (source.domain ?? "").trim().toLowerCase();
  for (const [re, code] of DOMAIN_OVERRIDES) if (re.test(d)) return code;
  const tld = d.split(".").pop() ?? "";
  return tld.length === 2 ? tld.toUpperCase() : "";
}

export function sourceLabel(source: LabelSource): string {
  const code = countryCode(source);
  const country = COUNTRY_NAMES[code] ?? (code || "Other");
  // Strip any existing country suffix from the name to avoid duplication
  const cleanName = source.name
    .replace(
      /\s*[—–-]\s*(Malta|Italy|France|Germany|Spain|Portugal|Brazil|Netherlands|Croatia|Gibraltar|Cyprus|Greece|Turkey|Tunisia|Morocco|Denmark|United Kingdom|EU|European Union)\s*(\(.*\))?$/i,
      "",
    )
    .trim();
  return `${country} — ${cleanName}`;
}

export function sortSourcesForPicker<T extends LabelSource>(sources: T[]): T[] {
  return [...sources].sort((a, b) =>
    sourceLabel(a).localeCompare(sourceLabel(b), undefined, { sensitivity: "base" }),
  );
}
