import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getWebshareProxy, WebshareProxyError } from "./webshare-proxy.server";

const PASSWORD = "s3cret-pass";

beforeEach(() => {
  process.env["WEBSHARE_API_KEY"] = "test-key";
  process.env["WEBSHARE_PROXY_USERNAME"] = "user1";
  process.env["WEBSHARE_PROXY_PASSWORD"] = PASSWORD;
});
afterEach(() => vi.unstubAllGlobals());

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

describe("getWebshareProxy", () => {
  it("throws when a secret is missing", async () => {
    delete process.env["WEBSHARE_PROXY_PASSWORD"];
    await expect(getWebshareProxy("GR")).rejects.toBeInstanceOf(WebshareProxyError);
  });

  it("throws on 401 without leaking the password", async () => {
    mockFetch(401, { detail: "no" });
    const err = await getWebshareProxy("GR").catch((e: Error) => e);
    expect(err).toBeInstanceOf(WebshareProxyError);
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).not.toContain(PASSWORD);
  });

  it("throws on an empty list", async () => {
    mockFetch(200, { results: [] });
    await expect(getWebshareProxy("GR")).rejects.toThrow(/No Webshare proxies/);
  });

  it("builds the proxy URL from env and the chosen proxy", async () => {
    mockFetch(200, { results: [{ proxy_address: "1.2.3.4", port: 8080, valid: true }] });
    await expect(getWebshareProxy("GR")).resolves.toBe(`http://user1:${PASSWORD}@1.2.3.4:8080`);
  });
});
