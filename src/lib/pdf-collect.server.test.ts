import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  storageLoaded: 0,
  sightings: [] as unknown[],
  extractions: [] as unknown[],
  writes: 0,
  uploads: 0,
  pendingInserts: 0,
  unpdfCalls: 0,
  parallelCalls: 0,
  parallelText: "Parallel text of the act",
}));

vi.mock("./parallel-fetch.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("./parallel-fetch.server")>();
  return {
    ...real,
    extractWithParallel: async () => {
      state.parallelCalls++;
      return { text: state.parallelText, title: "T" };
    },
  };
});

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
  return { ...real, getDocumentProxy: async () => { state.unpdfCalls++; return fakeProxy; } };
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
          state.pendingInserts++; state.writes++;
          if (rows.has(row.file_sha256)) return null;
          const r = { id: "copy-1", storage_status: "pending", updated_at: token(), size_bytes: row.size_bytes, file_sha256: row.file_sha256 };
          rows.set(row.file_sha256, r);
          return { ...r };
        },
        getByHash: async (h: string) => rows.get(h) ?? null,
        fencedUpdate: async (id: string, t: string, patch: { storage_status: string }) => {
          state.writes++;
          const r = [...rows.values()].find((x) => x.id === id);
          if (!r || r.updated_at !== t || r.storage_status !== "pending") return null;
          r.storage_status = patch.storage_status;
          r.updated_at = token();
          return r.updated_at;
        },
        insertSighting: async (row: unknown) => { state.writes++; state.sightings.push(row); return "s1"; },
        insertExtraction: async (row: unknown) => { state.writes++; state.extractions.push(row); return "e1"; },
      },
      store: {
        upload: async (p: string, b: Uint8Array) => { state.uploads++; state.writes++; if (objects.has(p)) return "exists"; objects.set(p, b.slice()); return "created"; },
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
  state.writes = 0;
  state.uploads = 0;
  state.pendingInserts = 0;
  state.unpdfCalls = 0;
  state.parallelCalls = 0;
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(PDF_BYTES, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(PDF_BYTES.length) } }),
  ));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["ORIGINALS_STORAGE_MODE"];
  delete process.env["ORIGINALS_INLINE_EXTRACT_MAX_BYTES"];
});

describe("runPdfCollection with ORIGINALS_STORAGE_MODE", () => {
  it("flag off (unset): storage module never loaded, no new fields (full comparison lives in pdf-collect.compat.test.ts)", async () => {
    const off = await run(undefined, true);
    expect(state.storageLoaded).toBe(0);
    expect(JSON.stringify(off.rawInserts[0])).not.toContain("original_storage");
    expect(off.jobUpdates[0]).not.toHaveProperty("run_params");
  });

  it("test mode without explicit request behaves exactly like off", async () => {
    const t = await run("test");
    expect(state.storageLoaded).toBe(0);
    expect(JSON.stringify(t.rawInserts[0])).not.toContain("original_storage");
  });

  it("flag on: same text and content_hash as off, plus original_storage and linked sighting/extraction", async () => {
    const off = await run(undefined);
    process.env["ORIGINALS_INLINE_EXTRACT_MAX_BYTES"] = "1000000";
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

  it("X1: enabled, inline cap unset: unpdf never called; Parallel used; stored copy has no extraction", async () => {
    const on = await run("test", true);
    expect(state.unpdfCalls).toBe(0);
    expect(state.parallelCalls).toBe(1);
    const p = on.rawInserts[0]!["raw_payload"] as Record<string, unknown>;
    expect(p["plain_text"]).toBe(state.parallelText);
    expect(p["extraction_method"]).toBe("parallel_extract");
    // the mocked copy store persists across tests, so the file may already be stored
    expect(p["original_storage"]).toEqual({ status: expect.stringMatching(/^(stored|deduplicated)$/), copy_id: "copy-1", inline_extract: "skipped_cap" });
    expect((p["attempts"] as unknown[])[0]).toEqual({ engine: "inline_pdf", ok: false, error: "inline_extract_cap" });
    expect(on.rawInserts[0]!["collector_version"]).not.toBe("http-pdf-fetch@1.0.0");
    expect(state.extractions).toEqual([]);
    expect(state.sightings[0]).toMatchObject({ copy_id: "copy-1" });
  });

  it("X1b: invalid cap values mean 0", async () => {
    for (const v of ["-5", "1.5", "abc", "0", ""]) {
      state.unpdfCalls = 0;
      process.env["ORIGINALS_INLINE_EXTRACT_MAX_BYTES"] = v;
      await run("test", true);
      expect(state.unpdfCalls).toBe(0);
    }
  });

  it("X2: file over the cap goes to Parallel, no extraction row", async () => {
    process.env["ORIGINALS_INLINE_EXTRACT_MAX_BYTES"] = String(PDF_BYTES.length - 1);
    await run("test", true);
    expect(state.unpdfCalls).toBe(0);
    expect(state.parallelCalls).toBe(1);
    expect(state.extractions).toEqual([]);
  });

  it("X3: file at the cap is parsed inline and the extraction is recorded", async () => {
    process.env["ORIGINALS_INLINE_EXTRACT_MAX_BYTES"] = String(PDF_BYTES.length);
    await run("test", true);
    expect(state.unpdfCalls).toBe(1);
    expect(state.parallelCalls).toBe(0);
    expect(state.extractions.length).toBe(1);
  });

  it("X4: flag off ignores the cap and parses as before", async () => {
    process.env["ORIGINALS_INLINE_EXTRACT_MAX_BYTES"] = "1";
    await run(undefined);
    expect(state.unpdfCalls).toBe(1);
    expect(state.parallelCalls).toBe(0);
    expect(state.storageLoaded).toBe(0);
  });

  it("R6: PDF over 52428800 in the enabled path: read cancelled, no upload, no copy row, fallback used, no late writes", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(8 * 1024 * 1024);
    chunk.set([0x25, 0x50, 0x44, 0x46]);
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) { pulled++; c.enqueue(chunk); },
          cancel() { cancelled = true; },
        }),
        { status: 200, headers: { "content-type": "application/pdf" } },
      ),
    ));
    const on = await run("test", true);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(9); // 7 chunks fit, the 8th crosses; at most one queued ahead
    expect(state.uploads).toBe(0);
    expect(state.pendingInserts).toBe(0);
    const p = on.rawInserts[0]!["raw_payload"] as Record<string, unknown>;
    expect(p["original_storage"]).toEqual({ status: "not_stored_size_limit", inline_extract: "skipped_cap" });
    expect((p["attempts"] as unknown[])[0]).toEqual({ engine: "inline_pdf", ok: false, error: "original_size_limit" });
    expect(state.sightings[0]).toMatchObject({ copy_id: null, byte_outcome: "not_stored_size_limit" });
    const w = state.writes;
    const pullsAfter = pulled;
    await new Promise((r) => setTimeout(r, 50));
    expect(state.writes).toBe(w);
    expect(pulled).toBe(pullsAfter);
  });
});
