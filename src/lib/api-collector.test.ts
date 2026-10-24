import { describe, expect, it } from "vitest";
import { getApiCollector } from "./api-collector";

describe("source-specific API routing", () => {
  it("sends normattiva.it to the Italian collector, not PISTE", () => {
    expect(getApiCollector("normattiva.it")).toBe("normattiva");
  });
  it.each([
    ["eur-lex.europa.eu", "eurlex"],
    ["boe.es", "boe"],
    ["legislation.gov.uk", "uk"],
    ["officielebekendmakingen.nl", "obk"],
    ["dou.gov.br", "dou"],
    ["et.gr", "fek"],
    ["piste.gouv.fr", "piste"],
    ["www.legifrance.gouv.fr", "piste"],
  ])("routes %s to %s", (domain, collector) => {
    expect(getApiCollector(domain)).toBe(collector);
  });
  it.each(["guardiacostiera.gov.it", "normattiva.it.example.com", "unknown.example"])(
    "does not send unsupported source %s to France",
    (domain) => expect(getApiCollector(domain)).toBeNull(),
  );
});