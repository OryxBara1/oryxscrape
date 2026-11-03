/**
 * Flag-off compatibility: the current runPdfCollection (ORIGINALS_STORAGE_MODE
 * unset) must behave exactly like the frozen pre-3a code in __legacy__/,
 * against the same mocks. Compared: every DB call and row (minus timestamps),
 * job counters, engine order, attempts, alerts and the return value.
 */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const S = vi.hoisted(() => ({
  pages: ["Article  1\nText ", "", " Article 2\n\n\n\nEnd"] as string[],
  parallel: { text: "Parallel text", error: null as string | null },
  webshare: { text: "Webshare text", error: null as string | null },
  engines: [] as string[],
  alerts: [] as unknown[],
}));

vi.mock("unpdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("unpdf")>();
  return {
    ...real,
    getDocumentProxy: async () => ({
      _pdfInfo: {},
      numPages: S.pages.length,
      getPage: async (n: number) => ({ getTextContent: async () => ({ items: [{ str: S.pages[n - 1], hasEOL: false }] }) }),
    }),
  };
});
vi.mock("./parallel-fetch.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("./parallel-fetch.server")>();
  return {
    ...real,
    extractWithParallel: async (url: string) => {
      S.engines.push(`parallel:${url}`);
      if (S.parallel.error) throw new Error(S.parallel.error);
      return { text: S.parallel.text, title: "PT" };
    },
  };
});
vi.mock("./webshare-fallback.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("./webshare-fallback.server")>();
  return {
    ...real,
    extractWithWebshare: async (url: string) => {
      S.engines.push(`webshare:${url}`);
      if (S.webshare.error) throw new Error(S.webshare.error);
      return { text: S.webshare.text, title: "WT" };
    },
  };
});
vi.mock("./webshare-proxy.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("./webshare-proxy.server")>();
  return { ...real, resolveProxyUrls: async () => null };
});
vi.mock("./ops-alerts.server", () => ({
  sendCollectionFailureAlert: async (a: Record<string, unknown>) => {
    S.alerts.push(a);
  },
}));

import { runPdfCollection as legacyRun } from "./__legacy__/pdf-collect.pre3a";
import { runPdfCollection as currentRun } from "./pdf-collect.server";

type Scenario = {
  name: string;
  targets: { url: string; document_label?: string }[];
  fetch: Record<string, () => Response | Promise<Response>>;
  proxy?: boolean;
  dupRaw?: string[]; // content-hash collisions: urls whose raw insert returns 23505
  setup?: () => void;
};

const pdfRes = () => new Response(new TextEncoder().encode("%PDF-1.7 x"), { status: 200, headers: { "content-type": "application/pdf" } });
const htmlRes = (len: number) => () => new Response(`<html><body><p>${"word ".repeat(len)}</p></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
const status = (code: number) => () => new Response("no", { status: code });

const scenarios: Scenario[] = [
  { name: "S1 PDF ok", targets: [{ url: "https://a.gr/1.pdf", document_label: "L1" }], fetch: { "https://a.gr/1.pdf": pdfRes } },
  { name: "S2 PDF no text -> blocked + alert", targets: [{ url: "https://a.gr/2.pdf" }], fetch: { "https://a.gr/2.pdf": pdfRes }, setup: () => (S.pages = ["", ""]) },
  { name: "S3 HTML >= 1000 chars", targets: [{ url: "https://a.gr/3" }], fetch: { "https://a.gr/3": htmlRes(400) } },
  { name: "S4 app shell -> Parallel", targets: [{ url: "https://a.gr/4" }], fetch: { "https://a.gr/4": htmlRes(3) } },
  { name: "S5 403 -> Parallel ok", targets: [{ url: "https://a.gr/5" }], fetch: { "https://a.gr/5": status(403) } },
  { name: "S6 403 -> Parallel empty, no proxy -> blocked", targets: [{ url: "https://a.gr/6" }], fetch: { "https://a.gr/6": status(403) }, setup: () => (S.parallel.text = "") },
  { name: "S7 403 -> Parallel fails -> Webshare ok", targets: [{ url: "https://a.gr/7" }], fetch: { "https://a.gr/7": status(403) }, proxy: true, setup: () => (S.parallel.error = "HTTP 500") },
  { name: "S8 403 -> Parallel fails -> Webshare fails -> blocked", targets: [{ url: "https://a.gr/8" }], fetch: { "https://a.gr/8": status(403) }, proxy: true, setup: () => { S.parallel.error = "HTTP 500"; S.webshare.error = "Webshare proxy crawl timed out"; } },
  { name: "S9 404 no retry", targets: [{ url: "https://a.gr/9" }], fetch: { "https://a.gr/9": status(404) } },
  { name: "S10 raw duplicate 23505", targets: [{ url: "https://a.gr/10.pdf" }], fetch: { "https://a.gr/10.pdf": pdfRes }, dupRaw: ["https://a.gr/10.pdf"] },
  { name: "S11 blocked duplicate (no re-alert, no extra read)", targets: [{ url: "https://a.gr/11" }], fetch: { "https://a.gr/11": status(403) }, dupRaw: ["https://a.gr/11"], setup: () => (S.parallel.text = "") },
  {
    name: "S12 mixed targets (counters)",
    targets: [{ url: "https://a.gr/1.pdf" }, { url: "https://a.gr/5" }, { url: "https://a.gr/9" }, { url: "https://a.gr/net" }],
    fetch: { "https://a.gr/1.pdf": pdfRes, "https://a.gr/5": status(403), "https://a.gr/9": status(404), "https://a.gr/net": () => { throw new TypeError("fetch failed"); } },
    setup: () => (S.parallel.text = "Parallel text"),
  },
];

function recorder(dupUrls: string[]) {
  const log: unknown[] = [];
  const raw = (row: Record<string, unknown>) => {
    const dup = dupUrls.includes(String(row["source_url"]));
    const result = dup ? { data: null, error: { code: "23505", message: "duplicate" } } : { data: { id: "raw-1" }, error: null };
    return {
      then: (a: (v: unknown) => unknown, b: (e: unknown) => unknown) => Promise.resolve(result).then(a, b),
      select: (cols: string) => {
        log.push({ op: "raw_items.insert.select", cols });
        return { single: async () => result };
      },
    };
  };
  const supabase = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          log.push({ op: `${table}.insert`, row: scrub(row) });
          if (table === "raw_items") return raw(row);
          return { select: () => ({ single: async () => ({ data: { id: "job-1" }, error: null }) }) };
        },
        update(patch: Record<string, unknown>) {
          log.push({ op: `${table}.update`, patch: scrub(patch) });
          return { eq: async () => ({ error: null }) };
        },
        select(cols: string) {
          log.push({ op: `${table}.select`, cols });
          const q = { eq: () => q, maybeSingle: async () => ({ data: { id: "raw-0" }, error: null }) };
          return q;
        },
      };
    },
  };
  return { supabase, log };
}

function scrub(o: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(o));
  for (const k of ["collected_at", "started_at", "finished_at"]) if (k in clone) clone[k] = "<ts>";
  if (clone.raw_payload && "attempted_at" in clone.raw_payload) clone.raw_payload.attempted_at = "<ts>";
  return clone;
}

async function exec(run: typeof currentRun, sc: Scenario) {
  S.pages = ["Article  1\nText ", "", " Article 2\n\n\n\nEnd"];
  S.parallel = { text: "Parallel text", error: null };
  S.webshare = { text: "Webshare text", error: null };
  S.engines = [];
  S.alerts = [];
  sc.setup?.();
  vi.stubGlobal("fetch", vi.fn(async (u: string) => {
    S.engines.push(`direct:${u}`);
    const f = sc.fetch[u];
    if (!f) throw new Error(`unexpected fetch ${u}`);
    return f();
  }));
  const { supabase, log } = recorder(sc.dupRaw ?? []);
  const source = {
    id: "src-1",
    is_official_domain: true,
    is_primary_document: true,
    traceability_level: "direct_url",
    institution_class: "government",
    ...(sc.proxy ? { proxy_config: { type: "webshare", country_code: "GR" } } : {}),
  };
  let result: unknown;
  try {
    result = await run({ supabase: supabase as never, source: source as never, profileId: null, targets: sc.targets });
  } catch (e) {
    result = { threw: (e as Error).message };
  }
  return { result, log, engines: [...S.engines], alerts: JSON.parse(JSON.stringify(S.alerts)) };
}

beforeEach(() => {
  delete process.env["ORIGINALS_STORAGE_MODE"];
  delete process.env["ORIGINALS_INLINE_EXTRACT_MAX_BYTES"];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("flag off == frozen pre-3a reference", () => {
  for (const sc of scenarios) {
    it(sc.name, async () => {
      const legacy = await exec(legacyRun as never, sc);
      const current = await exec(currentRun, sc);
      expect(current).toEqual(legacy);
      // guard that the scenario actually exercised something meaningful
      expect(legacy.log.length).toBeGreaterThan(1);
    });
  }

  it("scenarios cover blocked + alert, fallback order and counters", async () => {
    const s2 = await exec(currentRun, scenarios[1]!);
    expect(s2.alerts.length).toBe(1);
    const s8 = await exec(currentRun, scenarios[7]!);
    expect(s8.engines).toEqual(["direct:https://a.gr/8", "parallel:https://a.gr/8", "webshare:https://a.gr/8"]);
    expect(s8.alerts.length).toBe(1);
    const s11 = await exec(currentRun, scenarios[10]!);
    expect(s11.alerts.length).toBe(0);
    expect(s11.log.some((l) => (l as { op: string }).op === "raw_items.select")).toBe(false);
    const s12 = await exec(currentRun, scenarios[11]!);
    const upd = s12.log.find((l) => (l as { op: string }).op === "collection_jobs.update") as { patch: Record<string, unknown> };
    expect(upd.patch).toMatchObject({ fetched_count: 4, new_count: 3, failed_count: 1 });
  });

  it("unpdf version guard: mergePdfPages mirrors unpdf 1.8.1", () => {
    const pkg = JSON.parse(readFileSync("node_modules/unpdf/package.json", "utf8"));
    expect(pkg.version, "unpdf changed: re-check mergePdfPages against its normalizeMergedText").toBe("1.8.1");
  });
});
