// Mock-only: these tests do NOT exercise real DB triggers, RLS, unique indexes or CHECK constraints.
import { describe, expect, it, vi } from "vitest";

import {
  LDH_SEARCH_URL,
  QUOTA_24H,
  QUOTA_30D,
  STALE_RUN_MS,
  decideDedup,
  mapHit,
  runLdhSearchCore,
  validateSearchInput,
  type DiscoveryStore,
  type ExistingCandidate,
} from "./ldh-discovery.server";

const SECRET = "ldh_key_SECRET_123";
const FORBIDDEN = ["SNIPPET_XYZ", "SUMMARY_XYZ", "FULLTEXT_XYZ", "0.987654", "RAWBODY_XYZ", "X-Header-XYZ", SECRET];

const hit = (o: Record<string, unknown> = {}) => ({
  id: "h1",
  source: "MT_Legislation",
  source_id: "cap-234",
  score: 0.987654,
  title: "Merchant Shipping Act",
  url: "https://legislation.mt/eli/cap/234/eng?utm_source=x&b=2&a=1",
  country: "MT",
  authority: "parliament",
  identifier: "Cap. 234",
  language: "en",
  document_type: "act",
  snippet: "SNIPPET_XYZ",
  summary: "SUMMARY_XYZ",
  text: "FULLTEXT_XYZ",
  ...o,
});

function makeStore(opts: { busy?: boolean; count24?: number; count30?: number; existing?: ExistingCandidate[] } = {}) {
  const calls: { op: string; arg: unknown }[] = [];
  const store: DiscoveryStore = {
    expireStaleRuns: vi.fn(async (p, c) => void calls.push({ op: "expire", arg: { p, c } })),
    createRun: vi.fn(async () => {
      calls.push({ op: "createRun", arg: null });
      return opts.busy ? { busy: true as const } : { id: "run1" };
    }),
    countCountedSince: vi.fn(async (_p, since) => {
      const days = (Date.parse("2026-11-06T12:00:00Z") - Date.parse(since)) / 86_400_000;
      return days > 2 ? (opts.count30 ?? 0) : (opts.count24 ?? 0);
    }),
    reserveQuery: vi.fn(async (runId, input) => {
      calls.push({ op: "reserve", arg: { runId, input } });
      return "q1";
    }),
    finishQuery: vi.fn(async (id, patch) => void calls.push({ op: "finishQuery", arg: patch })),
    finishRun: vi.fn(async (id, patch) => void calls.push({ op: "finishRun", arg: patch })),
    findByKeys: vi.fn(async () => opts.existing ?? []),
    insertCandidate: vi.fn(async (row) => {
      calls.push({ op: "insertCandidate", arg: row });
      return { id: "c-new" };
    }),
    insertSighting: vi.fn(async (row) => void calls.push({ op: "insertSighting", arg: row })),
  };
  return { store, calls };
}

const okFetch = (hits: unknown[]) =>
  vi.fn(async () => new Response(JSON.stringify({ query: "x", hits, total_hits: hits.length, raw: "RAWBODY_XYZ" }), {
    status: 200,
    headers: { "X-Debug": "X-Header-XYZ" },
  }));

const NOW = () => Date.parse("2026-11-06T12:00:00Z");
const input = validateSearchInput({ q: "ship registration", namespace: "legislation", country: "MT" });

describe("LDH request", () => {
  it("sends only allowed fields, top_k=10, no result_detail, to /v1/search", async () => {
    const { store } = makeStore();
    const f = okFetch([]);
    await runLdhSearchCore(input, { store, userId: "u", apiKey: SECRET, fetchImpl: f, now: NOW });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(LDH_SEARCH_URL);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ q: "ship registration", namespace: "legislation", top_k: 10, country: ["MT"] });
  });

  it("rejects bad input", () => {
    expect(() => validateSearchInput({ q: "", namespace: "legislation" })).toThrow();
    expect(() => validateSearchInput({ q: "x", namespace: "full" })).toThrow();
    expect(() => validateSearchInput({ q: "x", namespace: "legislation", country: "mt" })).toThrow();
  });
});

describe("allowlist", () => {
  it("no snippet/summary/text/score/raw body/header/key in writes, logs or result", async () => {
    const { store, calls } = makeStore();
    const logs: unknown[] = [];
    const result = await runLdhSearchCore(input, {
      store, userId: "u", apiKey: SECRET, fetchImpl: okFetch([hit()]), now: NOW,
      log: (c, i) => logs.push([c, i]),
    });
    const blob = JSON.stringify({ calls, logs, result });
    for (const s of FORBIDDEN) expect(blob).not.toContain(s);
    expect(result.created).toBe(1);
  });

  it("keeps URL byte-identical, including http, params and trailing slash", () => {
    const u = "http://example.gov/a//b/?utm_source=z&b=2&a=1";
    const m = mapHit(hit({ url: u }));
    expect(m.ok && m.row.found_url).toBe(u);
    expect(m.ok && m.row.key_url).toBeNull();
    const u2 = "https://x.gov/p/?b=2&a=1&utm_campaign=q";
    const m2 = mapHit(hit({ url: u2 }));
    expect(m2.ok && m2.row.key_url).toBe(`url:${u2}`);
  });

  it("does not rewrite invalid ids: drops them; no key -> unusable", () => {
    const m = mapHit(hit({ source: "bad source!", country: "mt", authority: "Parliament of Malta" }));
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(m.row.provider_source).toBeNull();
      expect(m.row.provider_source_id).toBeNull();
      expect(m.row.country_code).toBeNull();
      expect(m.row.issuing_authority).toBeNull();
      expect(m.row.key_identifier).toBeNull();
    }
    const u = mapHit(hit({ source: "bad source!", url: "http://x.gov/", country: null }));
    expect(u).toEqual({ ok: false, reason: "no_valid_dedup_key" });
  });

  it("confidence is hypothesis only", () => {
    const m = mapHit(hit());
    expect(m.ok && Object.values(m.row.confidence).every((v) => v === "hypothesis")).toBe(true);
    expect(m.ok && m.row.key_provider).toBe("prov:ldh:mt_legislation:cap-234");
  });
});

describe("dedup", () => {
  const row = (mapHit(hit()) as { ok: true; row: Parameters<typeof decideDedup>[0] }).row;
  it("one candidate -> sighting with strongest key", () => {
    expect(decideDedup(row, [{ id: "a", key_provider: row.key_provider, key_identifier: null, key_url: row.key_url }]))
      .toEqual({ kind: "sighting", candidateId: "a", matchedKey: "provider" });
  });
  it("different candidates -> conflict, zero candidate/sighting writes", async () => {
    const existing = [
      { id: "a", key_provider: row.key_provider, key_identifier: null, key_url: null },
      { id: "b", key_provider: null, key_identifier: null, key_url: row.key_url },
    ];
    const { store, calls } = makeStore({ existing });
    const r = await runLdhSearchCore(input, { store, userId: "u", apiKey: SECRET, fetchImpl: okFetch([hit()]), now: NOW });
    expect(r.conflicts).toEqual([{ index: 0, candidateIds: ["a", "b"] }]);
    expect(calls.filter((c) => c.op === "insertCandidate" || c.op === "insertSighting")).toHaveLength(0);
    expect(r.status).toBe("partial");
  });
});

describe("reservation and quota", () => {
  it("losing the race makes no LDH call", async () => {
    const { store } = makeStore({ busy: true });
    const f = okFetch([]);
    const r = await runLdhSearchCore(input, { store, userId: "u", apiKey: SECRET, fetchImpl: f, now: NOW });
    expect(r.status).toBe("busy");
    expect(f).not.toHaveBeenCalled();
    expect(store.reserveQuery).not.toHaveBeenCalled();
  });
  it.each([
    [{ count24: QUOTA_24H }, "quota_24h"],
    [{ count30: QUOTA_30D }, "quota_30d"],
  ])("quota %o blocks with no call", async (o, code) => {
    const { store } = makeStore(o);
    const f = okFetch([]);
    const r = await runLdhSearchCore(input, { store, userId: "u", apiKey: SECRET, fetchImpl: f, now: NOW });
    expect(r.errorCode).toBe(code);
    expect(f).not.toHaveBeenCalled();
  });
  it("counts before dispatch; timeout stays counted; exactly one call", async () => {
    vi.useFakeTimers();
    const { store, calls } = makeStore();
    const f = vi.fn((_u: string, init: RequestInit) => {
      expect(calls.some((c) => c.op === "reserve")).toBe(true);
      return new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(new Error("abort"))));
    });
    const p = runLdhSearchCore(input, { store, userId: "u", apiKey: SECRET, fetchImpl: f as unknown as typeof fetch, now: NOW });
    await vi.advanceTimersByTimeAsync(31_000);
    const r = await p;
    vi.useRealTimers();
    expect(f).toHaveBeenCalledTimes(1);
    expect(r.errorCode).toBe("ldh_timeout");
    expect(calls.find((c) => c.op === "finishQuery")?.arg).toMatchObject({ status: "failed", error_kind: "timeout" });
  });
  it("429 is a counted failure, no retry", async () => {
    const { store } = makeStore();
    const f = vi.fn(async () => new Response("RAWBODY_XYZ", { status: 429, headers: { "retry-after": "60" } }));
    const r = await runLdhSearchCore(input, { store, userId: "u", apiKey: SECRET, fetchImpl: f, now: NOW });
    expect(f).toHaveBeenCalledTimes(1);
    expect(r.errorCode).toBe("ldh_rate_limit");
    expect(r.quota.used24h).toBe(1);
    expect(JSON.stringify(r)).not.toContain("RAWBODY_XYZ");
  });
  it("stale expiry cutoff is now - 120 s", async () => {
    const { store } = makeStore();
    await runLdhSearchCore(input, { store, userId: "u", apiKey: SECRET, fetchImpl: okFetch([]), now: NOW });
    expect(store.expireStaleRuns).toHaveBeenCalledWith("ldh", new Date(NOW() - STALE_RUN_MS).toISOString());
  });
  it("missing key: no call, no writes", async () => {
    const { store, calls } = makeStore();
    const f = okFetch([]);
    const r = await runLdhSearchCore(input, { store, userId: "u", apiKey: undefined, fetchImpl: f, now: NOW });
    expect(r.errorCode).toBe("config_missing");
    expect(f).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
  it.each([[401, "ldh_auth"], [422, "ldh_bad_request"], [503, "ldh_server"]])("HTTP %i -> %s", async (s, code) => {
    const { store } = makeStore();
    const r = await runLdhSearchCore(input, {
      store, userId: "u", apiKey: SECRET, fetchImpl: vi.fn(async () => new Response("x", { status: s })), now: NOW,
    });
    expect(r.errorCode).toBe(code);
  });
});
