/**
 * EU full text via the open CELLAR repository (no key). Content negotiation on
 * the CELEX resource URI returns the official English XHTML rendition, which
 * sidesteps the WAF challenge on eur-lex.europa.eu.
 */
const MAX_CHARS = 200_000;

function stripXhtml(xhtml: string): string {
  return xhtml
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|tr|h\d|li|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export async function fetchCellarText(
  celex: string,
): Promise<{ plain: string; url: string; truncated: boolean } | null> {
  try {
    const response = await fetch(
      `https://publications.europa.eu/resource/celex/${encodeURIComponent(celex)}`,
      {
        headers: {
          Accept: "application/xhtml+xml",
          "Accept-Language": "eng",
          "User-Agent": "OryxScrape/1.0",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(40_000),
      },
    );
    if (!response.ok) return null;
    const plain = stripXhtml(await response.text());
    if (!plain) return null;
    return {
      plain: plain.slice(0, MAX_CHARS),
      url: response.url,
      truncated: plain.length > MAX_CHARS,
    };
  } catch {
    return null;
  }
}
