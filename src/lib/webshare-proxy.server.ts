/**
 * Webshare proxy resolver (server-only).
 *
 * Credentials are read from project secrets at call time and never logged,
 * returned in errors, or stored in the database.
 */

export class WebshareProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebshareProxyError";
  }
}

type WebshareProxy = { proxy_address?: string; port?: number; valid?: boolean };

export async function getWebshareProxy(countryCode: string): Promise<string> {
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw new WebshareProxyError("Invalid proxy country code");
  }
  const apiKey = process.env["WEBSHARE_API_KEY"];
  const username = process.env["WEBSHARE_PROXY_USERNAME"];
  const password = process.env["WEBSHARE_PROXY_PASSWORD"];
  if (!apiKey || !username || !password) {
    throw new WebshareProxyError("Webshare credentials are not configured");
  }

  let response: Response;
  try {
    response = await fetch(
      `https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&country_code=${countryCode}&page_size=25`,
      { headers: { Authorization: `Token ${apiKey}` } },
    );
  } catch {
    throw new WebshareProxyError("Webshare API unreachable");
  }
  if (!response.ok) {
    throw new WebshareProxyError(`Webshare API returned HTTP ${response.status}`);
  }
  const body = (await response.json().catch(() => null)) as { results?: WebshareProxy[] } | null;
  const usable = (body?.results ?? []).filter(
    (p) => p.valid !== false && p.proxy_address && p.port,
  );
  if (!usable.length) {
    throw new WebshareProxyError(`No Webshare proxies available for ${countryCode}`);
  }
  const chosen = usable[Math.floor(Math.random() * usable.length)];
  return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${chosen.proxy_address}:${chosen.port}`;
}

export type ProxySummary = { type: "webshare"; country_code: string };

/** Reads a source's proxy_config safely; null when absent or unknown shape. */
export function readProxyConfig(source: unknown): ProxySummary | null {
  const raw = (source as Record<string, unknown> | null)?.["proxy_config"] ?? null;
  if (!raw || typeof raw !== "object") return null;
  const cfg = raw as Record<string, unknown>;
  if (cfg["type"] !== "webshare" || typeof cfg["country_code"] !== "string") return null;
  return { type: "webshare", country_code: cfg["country_code"] };
}

export async function resolveProxyUrls(config: ProxySummary | null): Promise<string[] | undefined> {
  if (!config) return undefined;
  return [await getWebshareProxy(config.country_code)];
}
