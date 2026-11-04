/**
 * Shutdown tests for Phase 1B step 3a originals storage, on a simulated clock.
 * No real services: every database / Storage call is an in-memory mock.
 *
 * Mock behaviours:
 *   ok    — resolves immediately
 *   hang  — never resolves on its own; rejects when its signal aborts (cooperative)
 *   delay — resolves after `ms` of simulated time; rejects early on abort (cooperative)
 *   late  — resolves after `ms` and IGNORES the signal (a remote call already sent)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_TIMINGS, preserveOriginal, readBodyCapped, type CopiesDb, type CopyRow, type ObjectStore } from "./document-storage.server";

type Mode<T> = { kind: "ok"; value: T } | { kind: "hang" } | { kind: "delay"; ms: number; value: T } | { kind: "late"; ms: number; value: T };

function behave<T>(mode: Mode<T>, signal: AbortSignal): Promise<T> {
  if (mode.kind === "ok") return Promise.resolve(mode.value);
  if (mode.kind === "late") return new Promise((res) => setTimeout(() => res(mode.value), mode.ms));
  return new Promise<T>((res, rej) => {
    if (signal.aborted) return rej(new Error("aborted"));
    const t = mode.kind === "delay" ? setTimeout(() => res(mode.value), mode.ms) : null;
    signal.addEventListener("abort", () => { if (t) clearTimeout(t); rej(new Error("aborted")); }, { once: true });
  });
}

/** Stream whose underlying source records pulls and cancellation. */
function trackedStream(chunks: Uint8Array[], opts: { hang?: boolean } = {}) {
  const s = { cancelled: false, pulled: 0, stream: null as unknown as ReadableStream<Uint8Array> };
  let i = 0;
  s.stream = new ReadableStream<Uint8Array>({
    pull(c): Promise<void> | undefined {
      s.pulled++;
      if (i < chunks.length) {
        c.enqueue(chunks[i++]!);
        return undefined;
      }
      if (opts.hang) return new Promise<void>(() => undefined);
      c.close();
      return undefined;
    },
    cancel() { s.cancelled = true; },
  }, { highWaterMark: 0 });
  return s;
}

type Call = { op: string; t: number; signal: AbortSignal | null; abortedAtCall: boolean };

function harness(o: {
  existing?: CopyRow;
  getByHash?: () => Mode<CopyRow | null>;
  fenced?: (n: number, status: string) => Mode<string | null>;
  upload?: Mode<"created" | "exists">;
  download?: (bytes: Uint8Array) => Mode<ReadableStream<Uint8Array> | null>;
}) {
  const calls: Call[] = [];
  const settled: { op: string; t: number }[] = [];
  const streams: ReturnType<typeof trackedStream>[] = [];
  let uploaded: Uint8Array | null = null;
  let fencedN = 0;
  let tok = 0;
  const rec = <T>(op: string, signal: AbortSignal | null, p: Promise<T>) => {
    calls.push({ op, t: Date.now(), signal, abortedAtCall: !!signal?.aborted });
    return p.finally(() => settled.push({ op, t: Date.now() }));
  };
  const db: CopiesDb = {
    insertPending(row, signal) {
      const r: CopyRow | null = o.existing ? null : { id: "copy-1", storage_status: "pending", updated_at: `tok-${tok++}`, size_bytes: row.size_bytes, file_sha256: row.file_sha256 };
      return rec("insertPending", signal, behave({ kind: "ok", value: r }, signal));
    },
    getByHash(_h, signal) {
      return rec("getByHash", signal, behave(o.getByHash?.() ?? { kind: "ok", value: o.existing ?? null }, signal));
    },
    fencedUpdate(_id, _token, patch, signal) {
      const n = fencedN++;
      return rec(`update:${patch.storage_status}`, signal, behave(o.fenced?.(n, patch.storage_status) ?? { kind: "ok", value: `tok-${tok++}` }, signal));
    },
    async insertSighting() { calls.push({ op: "insertSighting", t: Date.now(), signal: null, abortedAtCall: false }); return "s"; },
    async insertExtraction() { calls.push({ op: "insertExtraction", t: Date.now(), signal: null, abortedAtCall: false }); return "x"; },
  };
  const store: ObjectStore = {
    upload(_p, bytes, signal) {
      uploaded = bytes.slice();
      return rec("upload", signal, behave(o.upload ?? { kind: "ok", value: "created" }, signal));
    },
    download(_p, signal) {
      const mode = o.download?.(uploaded ?? new Uint8Array()) ?? (() => {
        const s = trackedStream([uploaded ?? new Uint8Array()]);
        streams.push(s);
        return { kind: "ok", value: s.stream } as Mode<ReadableStream<Uint8Array> | null>;
      })();
      return rec("download", signal, behave(mode, signal));
    },
  };
  return { db, store, calls, settled, streams, ops: () => calls.map((c) => c.op) };
}

const pdf = () => new TextEncoder().encode("%PDF-1.7\nshutdown-test");
const WRITE_OPS = /^(insertPending|upload|update:|insertSighting|insertExtraction)/;
const realTick = () => new Promise<void>((r) => setImmediate(r));

/** Advance simulated time in 100 ms steps until `p` settles. Returns the elapsed simulated ms. */
async function runToEnd<T>(p: Promise<T>, firstCall: () => boolean): Promise<{ value: T; elapsed: number }> {
  // SHA-256 (WebCrypto) completes on real time; do not move the clock before the first DB call.
  for (let i = 0; i < 1000 && !firstCall(); i++) await realTick();
  const start = Date.now();
  let done = false;
  let value!: T;
  void p.then((v) => { done = true; value = v; });
  for (let i = 0; i < 36_000 && !done; i++) await vi.advanceTimersByTimeAsync(100);
  if (!done) throw new Error("operation never ended within 1 h simulated");
  return { value, elapsed: Date.now() - start };
}

/** After shutdown: push the clock 1 h past every deadline and return any new calls. */
async function afterShutdown(h: ReturnType<typeof harness>) {
  const before = h.calls.length;
  await vi.advanceTimersByTimeAsync(3_600_000);
  return h.calls.slice(before);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const started = (h: ReturnType<typeof harness>) => () => h.calls.length > 0;

describe("shutdown: per-step timeouts (default timings)", () => {
  it("upload timeout (60 s): upload signal aborted, no verify/finalize, zero timers, nothing afterwards", async () => {
    const h = harness({ upload: { kind: "hang" } });
    const r = await runToEnd(preserveOriginal({ bytes: pdf(), declaredSize: null }, h), started(h));
    expect(r.value).toMatchObject({ status: "failed", errorClass: "timeout", copyId: "copy-1" });
    expect(r.elapsed).toBeGreaterThanOrEqual(DEFAULT_TIMINGS.uploadTimeoutMs);
    expect(r.elapsed).toBeLessThan(DEFAULT_TIMINGS.uploadTimeoutMs + 1000);
    const up = h.calls.find((c) => c.op === "upload")!;
    expect(up.signal!.aborted).toBe(true);
    expect(h.ops()).not.toContain("download");
    expect(h.ops().filter((o) => o === "update:stored" || o === "update:conflict")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(await afterShutdown(h)).toEqual([]);
  });

  it("verify timeout (60 s), stream stalls: stream reader cancelled, signal aborted, no finalize", async () => {
    let s!: ReturnType<typeof trackedStream>;
    const h = harness({ download: () => { s = trackedStream([], { hang: true }); return { kind: "ok", value: s.stream }; } });
    const r = await runToEnd(preserveOriginal({ bytes: pdf(), declaredSize: null }, h), started(h));
    expect(r.value).toMatchObject({ status: "failed", errorClass: "timeout" });
    expect(r.elapsed).toBeGreaterThanOrEqual(DEFAULT_TIMINGS.verifyTimeoutMs);
    expect(r.elapsed).toBeLessThan(DEFAULT_TIMINGS.verifyTimeoutMs + 1000);
    expect(h.calls.find((c) => c.op === "download")!.signal!.aborted).toBe(true);
    expect(s.cancelled).toBe(true);
    expect(h.ops().filter((o) => o === "update:stored" || o === "update:conflict")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(await afterShutdown(h)).toEqual([]);
  });

  it("verify timeout, download request itself hangs: download signal aborted", async () => {
    const h = harness({ download: () => ({ kind: "hang" }) });
    const r = await runToEnd(preserveOriginal({ bytes: pdf(), declaredSize: null }, h), started(h));
    expect(r.value).toMatchObject({ status: "failed", errorClass: "timeout" });
    expect(h.calls.find((c) => c.op === "download")!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(await afterShutdown(h)).toEqual([]);
  });

  it("wait on another run's fresh pending (30 s): bounded polls, then no more polls or takeover", async () => {
    const existing: CopyRow = { id: "copy-x", storage_status: "pending", updated_at: new Date("2026-11-04T12:00:00Z").toISOString(), size_bytes: 1, file_sha256: "sha256:x" };
    const h = harness({ existing });
    const r = await runToEnd(preserveOriginal({ bytes: pdf(), declaredSize: null }, h), started(h));
    expect(r.value).toMatchObject({ status: "pending_in_progress", errorClass: "pending_wait_timeout", copyId: "copy-x" });
    expect(r.elapsed).toBeGreaterThanOrEqual(DEFAULT_TIMINGS.waitTotalMs);
    expect(r.elapsed).toBeLessThan(DEFAULT_TIMINGS.waitTotalMs + DEFAULT_TIMINGS.waitPollMs + 1000);
    const polls = h.ops().filter((o) => o === "getByHash").length;
    expect(polls).toBe(DEFAULT_TIMINGS.waitTotalMs / DEFAULT_TIMINGS.waitPollMs + 1);
    expect(h.ops().filter((o) => WRITE_OPS.test(o) && o !== "insertPending")).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(await afterShutdown(h)).toEqual([]);
  });

  it("read timeout (readBodyCapped, 60 s): source cancelled, no further pulls, zero timers", async () => {
    const s = trackedStream([new TextEncoder().encode("%PDF-1.7")], { hang: true });
    const p = readBodyCapped(new Response(s.stream), 52_428_800, { timeoutMs: 60_000, declared: null });
    const r = await runToEnd(p, () => true);
    expect(r.value.kind).toBe("timeout");
    expect(r.elapsed).toBeGreaterThanOrEqual(60_000);
    expect(r.elapsed).toBeLessThan(61_000);
    expect(s.cancelled).toBe(true);
    const pulled = s.pulled;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(s.pulled).toBe(pulled);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("shutdown: 150 s whole-step deadline", () => {
  it("ends the operation while upload is still within its own (longer) deadline", async () => {
    const h = harness({ upload: { kind: "hang" } });
    const r = await runToEnd(preserveOriginal({ bytes: pdf(), declaredSize: null }, { ...h, timings: { uploadTimeoutMs: 400_000 } }), started(h));
    expect(r.value).toMatchObject({ status: "failed", errorClass: "timeout" });
    expect(r.elapsed).toBeGreaterThanOrEqual(DEFAULT_TIMINGS.totalTimeoutMs);
    expect(r.elapsed).toBeLessThan(DEFAULT_TIMINGS.totalTimeoutMs + 1000);
    expect(h.calls.find((c) => c.op === "upload")!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(await afterShutdown(h)).toEqual([]);
  });

  it("ends verify at 150 s total although verify has only used 50 of its 60 s", async () => {
    let s!: ReturnType<typeof trackedStream>;
    const h = harness({
      upload: { kind: "delay", ms: 100_000, value: "created" },
      download: () => { s = trackedStream([], { hang: true }); return { kind: "ok", value: s.stream }; },
    });
    const r = await runToEnd(preserveOriginal({ bytes: pdf(), declaredSize: null }, { ...h, timings: { uploadTimeoutMs: 110_000 } }), started(h));
    expect(r.value).toMatchObject({ status: "failed", errorClass: "timeout" });
    expect(r.elapsed).toBeGreaterThanOrEqual(150_000);
    expect(r.elapsed).toBeLessThan(151_000);
    expect(s.cancelled).toBe(true);
    expect(h.calls.find((c) => c.op === "download")!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(await afterShutdown(h)).toEqual([]);
  });

  it("ends the pending wait at 150 s when the wait budget is longer; the sleep timer is cleared", async () => {
    const existing: CopyRow = { id: "copy-x", storage_status: "pending", updated_at: new Date("2026-11-04T12:00:00Z").toISOString(), size_bytes: 1, file_sha256: "sha256:x" };
    const h = harness({ existing });
    const r = await runToEnd(preserveOriginal({ bytes: pdf(), declaredSize: null }, { ...h, timings: { waitTotalMs: 400_000, leaseMs: 1_000_000 } }), started(h));
    expect(r.value).toMatchObject({ status: "failed", errorClass: "timeout" });
    expect(r.elapsed).toBeGreaterThanOrEqual(150_000);
    expect(r.elapsed).toBeLessThan(151_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(await afterShutdown(h)).toEqual([]);
  });

  it("a heartbeat renewal in flight at the deadline is aborted; no renewal or finalize afterwards", async () => {
    // Renewals 0 (initial) succeed; the heartbeat at ~140 s hangs until aborted.
    const h = harness({
      upload: { kind: "hang" },
      fenced: (n) => (n >= 7 ? { kind: "hang" } : { kind: "ok", value: `t${n}` }),
    });
    const r = await runToEnd(preserveOriginal({ bytes: pdf(), declaredSize: null }, { ...h, timings: { uploadTimeoutMs: 400_000 } }), started(h));
    expect(r.value).toMatchObject({ status: "failed", errorClass: "timeout" });
    const renewals = h.calls.filter((c) => c.op === "update:pending");
    expect(renewals.length).toBe(8); // initial + heartbeats at 20..140 s
    expect(renewals.at(-1)!.signal!.aborted).toBe(true);
    expect(renewals.every((c) => !c.abortedAtCall)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(await afterShutdown(h)).toEqual([]);
  });
});

describe("shutdown: late responses after cancellation", () => {
  it("upload already sent answers after the timeout: no verify, renewal or finalize follows", async () => {
    const h = harness({ upload: { kind: "late", ms: 90_000, value: "created" } });
    const r = await runToEnd(preserveOriginal({ bytes: pdf(), declaredSize: null }, h), started(h));
    expect(r.value).toMatchObject({ status: "failed", errorClass: "timeout" });
    expect(r.elapsed).toBeLessThan(61_000);
    const tail = await afterShutdown(h);
    expect(h.settled.some((x) => x.op === "upload")).toBe(true); // the late answer did arrive
    expect(tail).toEqual([]);
    expect(h.ops()).not.toContain("download");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("download answered late (after the verify timeout): its stream is cancelled and nothing is written", async () => {
    let s!: ReturnType<typeof trackedStream>;
    const h = harness({
      download: (b) => { s = trackedStream([b]); return { kind: "late", ms: 90_000, value: s.stream }; },
    });
    const r = await runToEnd(preserveOriginal({ bytes: pdf(), declaredSize: null }, h), started(h));
    expect(r.value).toMatchObject({ status: "failed", errorClass: "timeout" });
    const tail = await afterShutdown(h);
    expect(tail).toEqual([]);
    expect(h.ops().filter((o) => o === "update:stored" || o === "update:conflict")).toEqual([]);
    expect(s.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a late readBodyCapped chunk after the read timeout is not consumed further", async () => {
    let resolvePull!: () => void;
    let cancelled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        if (pulls === 1) return void c.enqueue(new TextEncoder().encode("%PDF"));
        return new Promise<void>((res) => { resolvePull = () => { c.enqueue(new Uint8Array(10)); res(); }; });
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const p = readBodyCapped(new Response(stream), 52_428_800, { timeoutMs: 60_000, declared: null });
    const r = await runToEnd(p, () => true);
    expect(r.value.kind).toBe("timeout");
    expect(cancelled).toBe(true);
    try { resolvePull?.(); } catch { /* stream already cancelled */ }
    const n = pulls;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(pulls).toBe(n);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("normal finalization", () => {
  it("stored: every timer cleared, no callback fires afterwards, no extra call", async () => {
    const h = harness({ upload: { kind: "delay", ms: 45_000, value: "created" } });
    const r = await runToEnd(preserveOriginal({ bytes: pdf(), declaredSize: null }, h), started(h));
    expect(r.value).toMatchObject({ status: "stored", copyId: "copy-1" });
    expect(h.ops().filter((o) => o === "update:stored")).toHaveLength(1);
    expect(h.calls.filter((c) => c.op === "update:pending").length).toBeGreaterThanOrEqual(3); // heartbeats did run
    expect(vi.getTimerCount()).toBe(0);
    expect(await afterShutdown(h)).toEqual([]);
  });

  it("conflict: finalize clears timers too", async () => {
    const h = harness({ download: () => ({ kind: "ok", value: trackedStream([new TextEncoder().encode("%PDF-other")]).stream }) });
    const r = await runToEnd(preserveOriginal({ bytes: pdf(), declaredSize: null }, h), started(h));
    expect(r.value).toMatchObject({ status: "failed", errorClass: "storage_conflict" });
    expect(h.ops().filter((o) => o === "update:conflict")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(await afterShutdown(h)).toEqual([]);
  });

  it("readBodyCapped ok: read timer cleared", async () => {
    const s = trackedStream([new TextEncoder().encode("%PDF-1.7 ok")]);
    const r = await runToEnd(readBodyCapped(new Response(s.stream), 52_428_800, { timeoutMs: 60_000, declared: null }), () => true);
    expect(r.value.kind).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });
});
