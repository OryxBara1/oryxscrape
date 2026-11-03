import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ storageLoaded: 0, sightings: [] as unknown[], extractions: [] as unknown[] }));

vi.mock("unpdf", async (importOriginal) => {
  const real = await importOriginal<typeof import("unpdf")>();
  // Fake pdf.js document: page 2 is blank (image-only), page 3 has spacing.
  const pages = ["Article  1\nText   of the act ", "", "  Article 2\n\n\n\nEnd"];
  const fakeProxy = {
    _pdfInfo: {},
    numPages: pages.length,
    getPage: async (n: number) => ({
      getTextContent: async () => ({ items: [{ str: pages[n - 1], hasEOL: false }] }),
    }),
  };
  return { ...real, getDocumentProxy: async () => fakeProxy };
});

vi.mock("./document-storage.server", async (importOriginal) => {
  state.storageLoaded++;
  const real = await importOriginal<typeof import("./document-storage.server")>();
  const rows = new Map<string, { id: string; storage_status: string; updated_at: string; size_bytes: number; file_sha256: string }>();
  const objects = new Map<string, Uint8Array>();
  let n = 0;
  const token = () => `2026-11-03T13:45:00.${String(100000 + n++)}+00:00`;
  return {
    ...real,
    createStorageDeps: async () => ({
      db: {
        insertPending: async (row: { file_sha256: string; size_bytes: number }) => {
          if (rows.has(row.file_sha256)) return null;
          const r = { id: "copy-1", storage_status: "pending", updated_at: token(), size_bytes: row.size_bytes, file_sha256: row.file_sha256 };
          rows.set(row.file_sha256, r);
          return { ...r };
        },
        getByHash: async (h: string) => rows.get(h) ?? null,
        fencedUpdate: async (id: string, t: string, patch: { storage_status: string }) => {
          const r = [...rows.values()].find((x) => x.id === id);
          if (!r || r.updated_at !== t || r.storage_status !== "pending") return null;
          r.storage_status = patch.storage_status;
          r.updated_at = token();
          return r.updated_at;
        },
        insertSighting: async (row: unknown) => { state.sightings.push(row); return "s1"; },
        insertExtraction: async (row: unknown) => { state.extractions.push(row); return "e1"; },
      },
      store: {
        upload: async (p: string, b: Uint8Array) => { if (objects.has(p)) return "exists"; objects.set(p, b.slice()); return "created"; },
        download: async (p: string) => {
          const b = objects.get(p);
          return b ? new ReadableStream({ start(c) { c.enqueue(b); c.close(); } }) : null;
        },
      },
      timings: { heartbeatMs: 1000 },
    }),
  };
});

import { runPdfCollection } from "./pdf-collect.server";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7 fake body");

function fakeSupabase() {
  const rawInserts: Record<string, unknown>[] = [];
  const jobUpdates: Record<string, unknown>[] = [];
  const supabase = {
    from(table: string) {
      if (table === "collection_jobs") {
        return {
          insert: () => ({ select: () => ({ single: async () => ({ data: { id: "job-1" }, error: null }) }) }),
          update: (patch: Record<string, unknown>) => ({ eq: async () => { jobUpdates.push(patch); return { error: null }; } }),
        };
      }
      if (table === "raw_items") {
        return {
          insert: (row: Record<string, unknown>) => {
            rawInserts.push(row);
            const result = { data: null, error: null };
            return {
              then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej),
              select: () => ({ single: async () => ({ data: { id: "raw-1" }, error: null }) }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { supabase, rawInserts, jobUpdates };
}

const source = {
  id: "src-1",
  is_official_domain: true,
  is_primary_document: true,
  traceability_level: "direct_url",
  institution_class: "government",
} as const;

async function run(mode: string | undefined, storeOriginals?: boolean) {
  if (mode === undefined) delete process.env["ORIGINALS_STORAGE_MODE"];
  else process.env["ORIGINALS_STORAGE_MODE"] = mode;
  const f = fakeSupabase();
  await runPdfCollection({
    supabase: f.supabase as never,
    source: source as never,
    profileId: null,
    targets: [{ url: "https://example.gr/act.pdf" }],
    trigger: "manual",
    ...(storeOriginals !== undefined ? { storeOriginals } : {}),
  });
  return f;
}

beforeEach(() => {
  state.storageLoaded = 0;
  state.sightings = [];
  state.extractions = [];
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(PDF_BYTES, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(PDF_BYTES.length) } }),
  ));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["ORIGINALS_STORAGE_MODE"];
});

/** The raw_items row as the code wrote it before step 3a. */
async function legacyExpectedRaw(text: string) {
  const { sha256Hex } = await import("./consumer-keys.server");
  return {
    job_id: "job-1",
    source_id: "src-1",
    source_url: "https://example.gr/act.pdf",
    raw_payload: { plain_text: text, document_label: null, byte_length: PDF_BYTES.length },
    content_hash: await sha256Hex(text),
    collection_method: "http",
    is_official_domain: true,
    is_primary_document: true,
    traceability_level: "direct_url",
    institution_class: "government",
    canonical_url: "https://example.gr/act.pdf",
    http_status: 200,
    content_type: "application/pdf",
    language: null,
    apify_actor_id: null,
    apify_run_id: null,
    collector_version: "http-pdf-fetch@1.0.0",
  };
}

describe("runPdfCollection with ORIGINALS_STORAGE_MODE", () => {
  it("flag off (unset): identical legacy row, storage module never loaded, no new fields", async () => {
    const off = await run(undefined, true);
    expect(state.storageLoaded).toBe(0);
    const row = off.rawInserts[0]!;
    const { collected_at, ...rest } = row;
    expect(typeof collected_at).toBe("string");
    const { extractText } = await import("unpdf");
    const legacy = await extractText((await (await import("unpdf")).getDocumentProxy(PDF_BYTES)) as never, { mergePages: true });
    const legacyText = String(legacy.text).replace(/\u0000/g, "").trim();
    expect(rest).toEqual(await legacyExpectedRaw(legacyText));
    expect(JSON.stringify(row)).not.toContain("original_storage");
    expect(off.jobUpdates[0]).not.toHaveProperty("run_params");
  });

  it("test mode without explicit request behaves exactly like off", async () => {
    const t = await run("test");
    expect(state.storageLoaded).toBe(0);
    expect(JSON.stringify(t.rawInserts[0])).not.toContain("original_storage");
  });

  it("flag on: same text and content_hash as off, plus original_storage and linked sighting/extraction", async () => {
    const off = await run(undefined);
    const on = await run("test", true);
    const a = off.rawInserts[0]!;
    const b = on.rawInserts[0]!;
    expect((b["raw_payload"] as Record<string, unknown>)["plain_text"]).toBe((a["raw_payload"] as Record<string, unknown>)["plain_text"]);
    expect(b["content_hash"]).toBe(a["content_hash"]);
    expect((b["raw_payload"] as Record<string, unknown>)["original_storage"]).toEqual({ status: "stored", copy_id: "copy-1" });
    // payload holds the file outcome only, never link/extraction status
    expect(JSON.stringify(b["raw_payload"])).not.toMatch(/link_status|extraction_status|sighting/);
    expect(state.sightings[0]).toMatchObject({ raw_item_id: "raw-1", copy_id: "copy-1", byte_outcome: "stored" });
    // page 2 is blank: still processed, not truncated
    expect(state.extractions[0]).toMatchObject({ copy_id: "copy-1", truncation_status: "complete", page_count_detected: 3 });
    const summary = (on.jobUpdates[0]!["run_params"] as { originals: Record<string, unknown>[] }).originals[0];
    expect(summary).toMatchObject({ raw_item_id: "raw-1", sighting: "ok", extraction: "ok" });
  });
});
