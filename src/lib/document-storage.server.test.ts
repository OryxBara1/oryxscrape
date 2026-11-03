import { describe, expect, it, vi } from "vitest";

import {
  CopyLease,
  MAX_ORIGINAL_BYTES,
  classifyTruncation,
  linkAfterRaw,
  originalPath,
  originalStoragePayload,
  preserveOriginal,
  sha256Prefixed,
  textPath,
  type CopiesDb,
  type CopyRow,
  type ObjectStore,
  type StorageDeps,
} from "./document-storage.server";
import { readOriginalsMode, shouldStoreOriginals } from "./originals-mode";

const pdf = (body = "hello") => new TextEncoder().encode(`%PDF-1.7\n${body}`);

/** Microsecond tokens that a JS Date round-trip would corrupt. */
let tick = 0;
const nextToken = () => `2026-11-03T13:45:00.${String(100001 + tick++).padStart(6, "0")}+00:00`;

function fakeDb(initial?: CopyRow) {
  const rows = new Map<string, CopyRow>();
  if (initial) rows.set(initial.file_sha256, initial);
  const calls: { op: string; token?: string; patch?: unknown; staleBefore?: string }[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let fencedDelay = 0;
  const db: CopiesDb & { rows: typeof rows; calls: typeof calls; stats: () => number; setDelay: (ms: number) => void } = {
    rows,
    calls,
    stats: () => maxConcurrent,
    setDelay: (ms) => (fencedDelay = ms),
    async insertPending(row) {
      calls.push({ op: "insertPending" });
      if (rows.has(row.file_sha256)) return null;
      const r: CopyRow = { id: `copy-${rows.size + 1}`, storage_status: "pending", updated_at: nextToken(), size_bytes: row.size_bytes, file_sha256: row.file_sha256 };
      rows.set(r.file_sha256, r);
      return { ...r };
    },
    async getByHash(hash) {
      calls.push({ op: "getByHash" });
      const r = rows.get(hash);
      return r ? { ...r } : null;
    },
    async fencedUpdate(id, token, patch, signal, staleBefore) {
      calls.push({ op: `update:${patch.storage_status}`, token, patch, ...(staleBefore ? { staleBefore } : {}) });
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        if (fencedDelay) await new Promise((r) => setTimeout(r, fencedDelay));
        if (signal.aborted) throw new Error("aborted");
        const r = [...rows.values()].find((x) => x.id === id);
        if (!r || r.storage_status !== "pending" || r.updated_at !== token) return null;
        if (staleBefore && !(Date.parse(r.updated_at) < Date.parse(staleBefore))) return null;
        r.storage_status = patch.storage_status;
        r.updated_at = nextToken();
        return r.updated_at;
      } finally {
        concurrent--;
      }
    },
    async insertSighting(row) {
      calls.push({ op: "insertSighting", patch: row });
      return "sighting-1";
    },
    async insertExtraction(row) {
      calls.push({ op: "insertExtraction", patch: row });
      return "extraction-1";
    },
  };
  return db;
}

function fakeStore(preset?: Record<string, Uint8Array>) {
  const objects = new Map<string, Uint8Array>(Object.entries(preset ?? {}));
  const log: string[] = [];
  const store: ObjectStore & { objects: typeof objects; log: string[] } = {
    objects,
    log,
    async upload(path, bytes) {
      log.push(`upload:${path}`);
      if (objects.has(path)) return "exists";
      objects.set(path, bytes.slice());
      return "created";
    },
    async download(path) {
      log.push(`download:${path}`);
      const b = objects.get(path);
      if (!b) return null;
      return new ReadableStream({ start(c) { c.enqueue(b.subarray(0, 3)); c.enqueue(b.subarray(3)); c.close(); } });
    },
  };
  return store;
}

const fast = { leaseMs: 120_000, heartbeatMs: 5, waitTotalMs: 50, waitPollMs: 10, uploadTimeoutMs: 1000, verifyTimeoutMs: 1000, totalTimeoutMs: 3000 };

describe("flag", () => {
  it("defaults to off and only stores in test mode for explicit manual requests", () => {
    expect(readOriginalsMode(undefined)).toBe("off");
    expect(readOriginalsMode("weird")).toBe("off");
    expect(shouldStoreOriginals("off", "manual", true)).toBe(false);
    expect(shouldStoreOriginals("test", "manual", true)).toBe(true);
    expect(shouldStoreOriginals("test", "manual", undefined)).toBe(false);
    expect(shouldStoreOriginals("test", "scheduled", true)).toBe(false);
    expect(shouldStoreOriginals("on", "scheduled", undefined)).toBe(true);
  });
});

describe("paths", () => {
  it("text path matches the DB CHECK exactly", async () => {
    const h = await sha256Prefixed(new TextEncoder().encode("x"));
    const hex = h.slice(7);
    expect(textPath(h)).toBe(`text/${hex.slice(0, 2)}/${hex}`);
    expect(textPath(h)).toMatch(/^text\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    expect(originalPath(h)).toMatch(/^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
  });
});

describe("preserveOriginal", () => {
  it("pending -> upload -> verify -> stored, in order", async () => {
    const db = fakeDb();
    const store = fakeStore();
    const out = await preserveOriginal({ bytes: pdf(), declaredSize: null }, { db, store, timings: fast });
    expect(out.status).toBe("stored");
    const ops = db.calls.map((c) => c.op).filter((o) => o !== "update:pending");
    expect(ops).toEqual(["insertPending", "update:stored"]);
    expect(store.log[0]).toMatch(/^upload:/);
    expect(store.log[1]).toMatch(/^download:/);
  });

  it("existing object with same bytes is accepted only after verification", async () => {
    const bytes = pdf();
    const path = originalPath(await sha256Prefixed(bytes));
    const store = fakeStore({ [path]: bytes });
    const db = fakeDb();
    const out = await preserveOriginal({ bytes, declaredSize: null }, { db, store, timings: fast });
    expect(out.status).toBe("stored");
    expect(store.log.some((l) => l.startsWith("download:"))).toBe(true);
  });

  it("existing object with different bytes becomes conflict, never overwritten", async () => {
    const bytes = pdf();
    const path = originalPath(await sha256Prefixed(bytes));
    const other = pdf("tampered");
    const store = fakeStore({ [path]: other });
    const db = fakeDb();
    const out = await preserveOriginal({ bytes, declaredSize: null }, { db, store, timings: fast });
    expect(out).toMatchObject({ status: "failed", errorClass: "storage_conflict" });
    expect(store.objects.get(path)).toEqual(other);
    expect([...db.rows.values()][0]?.storage_status).toBe("conflict");
  });

  it("insert conflict returns no row: existing row is read separately; stored -> deduplicated without upload", async () => {
    const bytes = pdf();
    const h = await sha256Prefixed(bytes);
    const db = fakeDb({ id: "copy-x", storage_status: "stored", updated_at: nextToken(), size_bytes: bytes.length, file_sha256: h });
    const store = fakeStore();
    const out = await preserveOriginal({ bytes, declaredSize: null }, { db, store, timings: fast });
    expect(out).toMatchObject({ status: "deduplicated", copyId: "copy-x" });
    expect(db.calls.map((c) => c.op)).toEqual(["insertPending", "getByHash"]);
    expect(store.log).toEqual([]);
  });

  it("conflict/missing rows are left untouched", async () => {
    const bytes = pdf();
    const h = await sha256Prefixed(bytes);
    const db = fakeDb({ id: "c", storage_status: "missing", updated_at: nextToken(), size_bytes: bytes.length, file_sha256: h });
    const out = await preserveOriginal({ bytes, declaredSize: null }, { db, store: fakeStore(), timings: fast });
    expect(out).toMatchObject({ status: "failed", errorClass: "copy_state_missing" });
    expect(db.calls.some((c) => c.op.startsWith("update"))).toBe(false);
  });

  it("fresh pending held by another run: bounded wait then pending_in_progress", async () => {
    const bytes = pdf();
    const h = await sha256Prefixed(bytes);
    const fresh = new Date().toISOString();
    const db = fakeDb({ id: "c", storage_status: "pending", updated_at: fresh, size_bytes: bytes.length, file_sha256: h });
    let clock = Date.now();
    const out = await preserveOriginal(
      { bytes, declaredSize: null },
      { db, store: fakeStore(), timings: fast, now: () => clock, sleep: async (ms) => { clock += ms; } },
    );
    expect(out).toMatchObject({ status: "pending_in_progress", errorClass: "pending_wait_timeout" });
    expect(db.calls.filter((c) => c.op === "getByHash").length).toBeGreaterThan(1);
  });

  it("stale pending is taken over with the exact token string and a staleness guard", async () => {
    const bytes = pdf();
    const h = await sha256Prefixed(bytes);
    const staleToken = "2026-11-03T10:00:00.123456+00:00";
    const db = fakeDb({ id: "c", storage_status: "pending", updated_at: staleToken, size_bytes: bytes.length, file_sha256: h });
    const out = await preserveOriginal({ bytes, declaredSize: null }, { db, store: fakeStore(), timings: fast, now: () => Date.parse("2026-11-03T13:00:00Z") });
    expect(out.status).toBe("stored");
    const takeover = db.calls.find((c) => c.staleBefore);
    expect(takeover?.token).toBe(staleToken);
  });

  it("preserves the token exactly as returned by the database (microseconds)", async () => {
    const db = fakeDb();
    await preserveOriginal({ bytes: pdf("tok"), declaredSize: null }, { db, store: fakeStore(), timings: fast });
    const updates = db.calls.filter((c) => c.op.startsWith("update"));
    expect(updates[0]?.token).toMatch(/\.\d{6}\+00:00$/);
    // each update uses the token returned by the previous write, byte for byte
    for (let i = 1; i < updates.length; i++) expect(updates[i]?.token).not.toBe(updates[i - 1]?.token);
    expect(new Date(updates[0]!.token!).toISOString()).not.toBe(updates[0]!.token);
  });

  it("an old run cannot finalize after another run took over", async () => {
    const bytes = pdf("race");
    const db = fakeDb();
    const store: ObjectStore = {
      ...fakeStore(),
      async upload(path, b) {
        // While this run uploads, a second run takes over the row (token changes).
        const row = [...db.rows.values()][0]!;
        row.updated_at = nextToken();
        void path; void b;
        return "created";
      },
      async download() {
        return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
      },
    };
    const out = await preserveOriginal({ bytes, declaredSize: null }, { db, store, timings: fast });
    expect(out).toMatchObject({ status: "pending_in_progress", errorClass: "lost_ownership" });
    expect(db.calls.some((c) => c.op === "update:stored" || c.op === "update:conflict")).toBe(false);
    expect([...db.rows.values()][0]?.storage_status).toBe("pending");
  });

  it("heartbeats never overlap and finalization waits for them", async () => {
    const db = fakeDb();
    db.setDelay(8);
    const store: ObjectStore = {
      ...fakeStore(),
      async upload() { await new Promise((r) => setTimeout(r, 60)); return "created"; },
      async download() { return new ReadableStream({ start(c) { c.enqueue(pdf("hb")); c.close(); } }); },
    };
    const out = await preserveOriginal({ bytes: pdf("hb"), declaredSize: null }, { db, store, timings: { ...fast, heartbeatMs: 2 } });
    expect(out.status).toBe("stored");
    expect(db.stats()).toBe(1);
    const ops = db.calls.map((c) => c.op);
    expect(ops[ops.length - 1]).toBe("update:stored");
  });

  it("CopyLease serializes concurrent renew calls", async () => {
    const db = fakeDb();
    db.setDelay(5);
    const row = (await db.insertPending({ file_sha256: "sha256:" + "a".repeat(64), size_bytes: 1, detected_mime_type: "application/pdf", storage_path: "p" }, new AbortController().signal))!;
    const lease = new CopyLease(db, row.id, row.updated_at, new AbortController().signal);
    const results = await Promise.all([lease.renew(), lease.renew(), lease.renew()]);
    expect(results).toEqual([true, true, true]);
    expect(db.stats()).toBe(1);
  });

  it("timeout cancels pending work and nothing is written afterwards", async () => {
    const db = fakeDb();
    const store: ObjectStore = {
      ...fakeStore(),
      upload: (_p, _b, signal) => new Promise((_r, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))),
      async download() { return null; },
    };
    const out = await preserveOriginal({ bytes: pdf("slow"), declaredSize: null }, { db, store, timings: { ...fast, uploadTimeoutMs: 20, heartbeatMs: 3 } });
    expect(out).toMatchObject({ status: "failed", errorClass: "timeout" });
    const count = db.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(db.calls.length).toBe(count);
    expect([...db.rows.values()][0]?.storage_status).toBe("pending");
  });

  it("size limit: known Content-Length over the limit, nothing touched", async () => {
    const db = fakeDb();
    const store = fakeStore();
    const out = await preserveOriginal({ bytes: pdf(), declaredSize: MAX_ORIGINAL_BYTES + 1 }, { db, store, timings: fast });
    expect(out.status).toBe("not_stored_size_limit");
    expect(db.calls).toEqual([]);
    expect(store.log).toEqual([]);
  });

  it("size limit: unknown Content-Length, actual size over the limit", async () => {
    const big = new Uint8Array(MAX_ORIGINAL_BYTES + 1);
    big.set([0x25, 0x50, 0x44, 0x46]);
    const db = fakeDb();
    const out = await preserveOriginal({ bytes: big, declaredSize: null }, { db, store: fakeStore(), timings: fast });
    expect(out.status).toBe("not_stored_size_limit");
    expect(db.calls).toEqual([]);
  });

  it("exactly at the limit with a lying smaller Content-Length is still stored", async () => {
    const big = new Uint8Array(MAX_ORIGINAL_BYTES);
    big.set([0x25, 0x50, 0x44, 0x46]);
    const out = await preserveOriginal({ bytes: big, declaredSize: 10 }, { db: fakeDb(), store: fakeStore(), timings: fast });
    expect(out.status).toBe("stored");
  });

  it("non-PDF bytes are never stored", async () => {
    const db = fakeDb();
    const out = await preserveOriginal({ bytes: new TextEncoder().encode("<html>"), declaredSize: null }, { db, store: fakeStore(), timings: fast });
    expect(out).toMatchObject({ status: "failed", errorClass: "not_pdf" });
    expect(db.calls).toEqual([]);
  });

  it("upload error -> failed with a class only, no secrets", async () => {
    const store: ObjectStore = { ...fakeStore(), upload: async () => { throw new Error("upload HTTP 500"); } };
    const out = await preserveOriginal({ bytes: pdf(), declaredSize: null }, { db: fakeDb(), store, timings: fast });
    expect(out).toMatchObject({ status: "failed", errorClass: "upload_error" });
    expect(originalStoragePayload(out)).toEqual({ status: "failed", error_class: "upload_error", copy_id: "copy-1" });
  });
});

describe("truncation", () => {
  it("blank or image-only pages are not truncation", () => {
    // 10 pages processed, most with no text: still complete processing.
    expect(classifyTruncation({ totalPages: 10, processedPages: 10 })).toBe("complete");
  });
  it("explicit cut signs are truncation", () => {
    expect(classifyTruncation({ totalPages: 10, processedPages: 7 })).toBe("truncated");
    expect(classifyTruncation({ totalPages: 3, processedPages: 3, cutSignalled: true })).toBe("truncated");
  });
  it("inconclusive is unknown", () => {
    expect(classifyTruncation({ totalPages: 0, processedPages: 0 })).toBe("unknown");
  });
});

describe("linkAfterRaw", () => {
  const base = { rawItemId: "raw-1", sourceId: "s", jobId: "j", fetchedUrl: "https://x.gr/a.pdf", receivedFilename: "a.pdf", informedMimeType: "application/pdf", declaredSize: 9 };
  const deps = (db: ReturnType<typeof fakeDb>): StorageDeps => ({ db, store: fakeStore(), timings: fast });

  it("stored: sighting linked to the raw item + extraction from these bytes", async () => {
    const db = fakeDb();
    const r = await linkAfterRaw({ ...base, outcome: { status: "stored", copyId: "c1", fileSha256: "h", sizeBytes: 9 }, extraction: { text: "t", tool: "unpdf", version: "unpdf@1.8.1", totalPages: 2, processedPages: 2 } }, deps(db));
    expect(r).toEqual({ sighting: "ok", extraction: "ok" });
    const s = db.calls.find((c) => c.op === "insertSighting")?.patch as Record<string, unknown>;
    expect(s).toMatchObject({ copy_id: "c1", raw_item_id: "raw-1", byte_outcome: "stored", fetch_method: "http", received_filename: "a.pdf", informed_mime_type: "application/pdf" });
    const x = db.calls.find((c) => c.op === "insertExtraction")?.patch as Record<string, unknown>;
    expect(x).toMatchObject({ copy_id: "c1", truncation_status: "complete", text_inline: "t", text_storage_path: null });
  });

  it("no extraction when text did not come from these bytes", async () => {
    const db = fakeDb();
    const r = await linkAfterRaw({ ...base, outcome: { status: "deduplicated", copyId: "c1", fileSha256: "h", sizeBytes: 9 }, extraction: null }, deps(db));
    expect(r).toEqual({ sighting: "ok", extraction: "not_applicable" });
    expect(db.calls.some((c) => c.op === "insertExtraction")).toBe(false);
  });

  it("size limit: sighting without copy, no extraction", async () => {
    const db = fakeDb();
    await linkAfterRaw({ ...base, outcome: { status: "not_stored_size_limit", sizeBytes: 1 }, extraction: { text: "t", tool: "unpdf", version: "v", totalPages: 1, processedPages: 1 } }, deps(db));
    const s = db.calls.find((c) => c.op === "insertSighting")?.patch as Record<string, unknown>;
    expect(s).toMatchObject({ copy_id: null, byte_outcome: "not_stored_size_limit" });
    expect(db.calls.some((c) => c.op === "insertExtraction")).toBe(false);
  });

  it("failed/pending outcomes create no sighting", async () => {
    const db = fakeDb();
    const r = await linkAfterRaw({ ...base, outcome: { status: "failed", errorClass: "timeout" }, extraction: null }, deps(db));
    expect(r).toEqual({ sighting: "not_applicable", extraction: "not_applicable" });
    expect(db.calls).toEqual([]);
  });

  it("sighting failure keeps the file outcome distinct", async () => {
    const db = fakeDb();
    db.insertSighting = vi.fn().mockRejectedValue(new Error("db"));
    const r = await linkAfterRaw({ ...base, outcome: { status: "stored", copyId: "c1", fileSha256: "h", sizeBytes: 9 }, extraction: null }, deps(db));
    expect(r).toMatchObject({ sighting: "failed", error_class: "sighting_insert_failed" });
  });

  it("text over 1 MB goes to text/<2>/<64> after verification", async () => {
    const db = fakeDb();
    const store = fakeStore();
    const text = "a".repeat(1_048_577);
    await linkAfterRaw({ ...base, outcome: { status: "stored", copyId: "c1", fileSha256: "h", sizeBytes: 9 }, extraction: { text, tool: "unpdf", version: "v", totalPages: 1, processedPages: 1 } }, { db, store, timings: fast });
    const x = db.calls.find((c) => c.op === "insertExtraction")?.patch as Record<string, unknown>;
    expect(x["text_inline"]).toBeNull();
    expect(String(x["text_storage_path"])).toMatch(/^text\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    expect(store.objects.has(String(x["text_storage_path"]))).toBe(true);
  });
});
