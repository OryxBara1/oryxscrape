/** API collectors are selected by an exact hostname, never by method alone. */
export function getApiCollector(domain: string) {
  const hostname = domain.trim().toLowerCase().replace(/^www\./, "");
  switch (hostname) {
    case "normattiva.it": return "normattiva";
    case "eur-lex.europa.eu": return "eurlex";
    case "boe.es": return "boe";
    case "legislation.gov.uk": return "uk";
    case "officielebekendmakingen.nl": return "obk";
    case "dou.gov.br": return "dou";
    case "et.gr": return "fek";
    case "piste.gouv.fr":
    case "legifrance.gouv.fr": return "piste";
    default: return null;
  }
}