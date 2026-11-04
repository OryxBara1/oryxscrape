/**
 * Preservation of original PDF files (Phase 1B step 3a, server-only).
 *
 * Only bytes received directly from the source are stored. Text produced by
 * another engine (Parallel, Apify/Webshare) is never attached to a copy.
 *
 * Sequence: hash → create-or-read `pending` copy → upload (no overwrite)
 *           → verify size + SHA-256 of the stored object → `stored`.
 *
 * Lease: `document_copies.updated_at` (refreshed by trigger on every update)
 * is used as a compare-and-set token. The token is kept EXACTLY as the
 * database returned it (text, microseconds) and never round-tripped through
 * JS Date. This is NOT strict fencing: now() is the transaction start time,
 * so two updates committed in the same microsecond could share a token.
 *
 * Every function here returns an outcome instead of throwing, and awaits all
 * of its own pending operations before returning (no background writes).
 */
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

export const ORIGINALS_BUCKET = "document-originals";
export const MAX_ORIGINAL_BYTES = 52_428_800;
export const MAX_INLINE_TEXT_BYTES = 1_048_576;

export type StorageTimings = {
  leaseMs: number;
  heartbeatMs: number;
  waitTotalMs: number;
  waitPollMs: number;
  uploadTimeoutMs: number;
  verifyTimeoutMs: number;
  totalTimeoutMs: number;
};

export const DEFAULT_TIMINGS: StorageTimings = {
  leaseMs: 120_000,
  heartbeatMs: 20_000,
  waitTotalMs: 30_000,
  waitPollMs: 2_000,
  uploadTimeoutMs: 60_000,
  verifyTimeoutMs: 60_000,
  totalTimeoutMs: 150_000,
};

export type CopyRow = {
  id: string;
  storage_status: "pending" | "stored" | "missing" | "conflict";
  /** Exact text as returned by the database. */
  updated_at: string;
  size_bytes: number;
  file_sha256: string;
};

export interface CopiesDb {
  /** Insert a pending row; null when a row with this hash already exists. */
  insertPending(row: { file_sha256: string; size_bytes: number; detected_mime_type: string; storage_path: string }, signal: AbortSignal): Promise<CopyRow | null>;
  getByHash(fileSha256: string, signal: AbortSignal): Promise<CopyRow | null>;
  /**
   * Update only if id, status=pending and updated_at=token still match
   * (and, when given, updated_at < staleBefore). Returns the new token or null.
   */
  fencedUpdate(
    id: string,
    token: string,
    patch: { storage_status: "pending" | "stored" | "conflict"; stored_at?: string },
    signal: AbortSignal,
    staleBefore?: string,
  ): Promise<string | null>;
  insertSighting(row: Record<string, unknown>): Promise<string>;
  insertExtraction(row: Record<string, unknown>): Promise<string>;
}

export interface ObjectStore {
  upload(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<"created" | "exists">;
  /** null = object not found. */
  download(path: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array> | null>;
}

export type StorageDeps = {
  db: CopiesDb;
  store: ObjectStore;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  timings?: Partial<StorageTimings>;
};

export type OriginalOutcome =
  | { status: "stored" | "deduplicated"; copyId: string; fileSha256: string; sizeBytes: number }
  | { status: "not_stored_size_limit"; sizeBytes: number | null }
  | { status: "failed" | "pending_in_progress"; errorClass: string; copyId?: string | undefined };

/** Payload written into raw_items.raw_payload.original_storage (file outcome only). */
export function originalStoragePayload(o: OriginalOutcome): Record<string, unknown> {
  if (o.status === "stored" || o.status === "deduplicated") return { status: o.status, copy_id: o.copyId };
  if (o.status === "not_stored_size_limit") return { status: o.status };
  if (o.status === "failed" || o.status === "pending_in_progress") {
    return { status: o.status, error_class: o.errorClass, ...(o.copyId ? { copy_id: o.copyId } : {}) };
  }
  return { status: "failed", error_class: "unknown" };
}

// ---------------------------------------------------------------- helpers

export function hasPdfMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += (b[i] ?? 0).toString(16).padStart(2, "0");
  return s;
}

export async function sha256Prefixed(bytes: Uint8Array): Promise<string> {
  return `sha256:${toHex(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource))}`;
}

export function originalPath(fileSha256: string): string {
  const hex = fileSha256.slice(7);
  return `sha256/${hex.slice(0, 2)}/${hex}`;
}

/** Must equal the DB CHECK: 'text/' || substr(hash,8,2) || '/' || substr(hash,8). */
export function textPath(textSha256: string): string {
  const hex = textSha256.slice(7);
  return `text/${hex.slice(0, 2)}/${hex}`;
}

export function parseContentLength(headers: Headers): number | null {
  const v = headers.get("content-length");
  if (!v || !/^\d+$/.test(v)) return null;
  return Number(v);
}

export function receivedFilename(headers: Headers, url: string): string | null {
  const cd = headers.get("content-disposition") ?? "";
  const star = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(cd);
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  let name: string | null = null;
  try {
    name = star?.[1] ? decodeURIComponent(star[1]) : (plain?.[1] ?? null);
  } catch {
    name = plain?.[1] ?? null;
  }
  if (!name) {
    try {
      const seg = new URL(url).pathname.split("/").filter(Boolean).pop();
      name = seg ? decodeURIComponent(seg) : null;
    } catch {
      name = null;
    }
  }
  return name ? name.trim().slice(0, 255) || null : null;
}

class TimeoutError extends Error {}

/** Child controller aborted by the parent or after `ms`. */
function childSignal(parent: AbortSignal, ms: number): { signal: AbortSignal; done: () => void } {
  const c = new AbortController();
  const onAbort = () => c.abort(parent.reason ?? new TimeoutError("aborted"));
  if (parent.aborted) onAbort();
  else parent.addEventListener("abort", onAbort, { once: true });
  const t = setTimeout(() => c.abort(new TimeoutError("timeout")), ms);
  return {
    signal: c.signal,
    done: () => {
      clearTimeout(t);
      parent.removeEventListener("abort", onAbort);
    },
  };
}

async function withTimeout<T>(parent: AbortSignal, ms: number, fn: (s: AbortSignal) => Promise<T>): Promise<T> {
  const { signal, done } = childSignal(parent, ms);
  try {
    return await new Promise<T>((resolve, reject) => {
      if (signal.aborted) return reject(new TimeoutError("timeout"));
      signal.addEventListener("abort", () => reject(new TimeoutError("timeout")), { once: true });
      fn(signal).then(resolve, reject);
    });
  } finally {
    done();
  }
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new TimeoutError("aborted"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(new TimeoutError("aborted")); }, { once: true });
  });

// ---------------------------------------------------------------- lease

class LostOwnership extends Error {}

/**
 * Serialized lease. All writes (heartbeats and finalization) go through one
 * promise chain, so two writes of the same run never overlap; a heartbeat
 * tick is skipped while one is still in flight.
 */
export class CopyLease {
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  lost = false;
  failed: Error | null = null;

  constructor(
    private db: CopiesDb,
    readonly copyId: string,
    private tokenValue: string,
    private signal: AbortSignal,
  ) {}

  get token() {
    return this.tokenValue;
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op, op);
    this.chain = next.catch(() => undefined);
    return next;
  }

  renew(): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.lost || this.failed || this.signal.aborted) return false;
      try {
        const t = await this.db.fencedUpdate(this.copyId, this.tokenValue, { storage_status: "pending" }, this.signal);
        if (t === null) {
          this.lost = true;
          return false;
        }
        this.tokenValue = t;
        return true;
      } catch (e) {
        this.failed = e as Error;
        return false;
      }
    });
  }

  startHeartbeat(ms: number) {
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = true;
      void this.renew().finally(() => {
        this.inFlight = false;
      });
    }, ms);
  }

  /** Stops the heartbeat and waits for any write in flight. */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.chain;
  }

  /** Stops the heartbeat, then writes the final state only if still owner. */
  async finalize(patch: { storage_status: "stored" | "conflict"; stored_at?: string }): Promise<boolean> {
    await this.stop();
    return this.enqueue(async () => {
      if (this.lost || this.failed || this.signal.aborted) return false;
      const t = await this.db.fencedUpdate(this.copyId, this.tokenValue, patch, this.signal);
      if (t === null) {
        this.lost = true;
        return false;
      }
      this.tokenValue = t;
      return true;
    });
  }
}

// ---------------------------------------------------------------- verify

async function hashStream(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<{ hash: string; size: number }> {
  const h = nobleSha256.create();
  let size = 0;
  const reader = stream.getReader();
  const onAbort = () => void reader.cancel().catch(() => undefined);
  if (signal.aborted) {
    await reader.cancel().catch(() => undefined);
    throw new TimeoutError("aborted");
  }
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new TimeoutError("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      h.update(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return { hash: `sha256:${toHex(h.digest())}`, size };
}

async function verifyObject(store: ObjectStore, path: string, expectHash: string, expectSize: number, signal: AbortSignal) {
  const stream = await store.download(path, signal);
  if (!stream) return "missing" as const;
  const { hash, size } = await hashStream(stream, signal);
  return hash === expectHash && size === expectSize ? ("match" as const) : ("mismatch" as const);
}

// ---------------------------------------------------------------- main

export async function preserveOriginal(
  input: { bytes: Uint8Array; declaredSize: number | null },
  deps: StorageDeps,
): Promise<OriginalOutcome> {
  const t = { ...DEFAULT_TIMINGS, ...deps.timings };
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const { db, store } = deps;
  const { bytes } = input;

  if ((input.declaredSize !== null && input.declaredSize > MAX_ORIGINAL_BYTES) || bytes.byteLength > MAX_ORIGINAL_BYTES) {
    return { status: "not_stored_size_limit", sizeBytes: bytes.byteLength || input.declaredSize };
  }
  if (bytes.byteLength === 0 || !hasPdfMagic(bytes)) return { status: "failed", errorClass: "not_pdf" };

  const total = new AbortController();
  const totalTimer = setTimeout(() => total.abort(new TimeoutError("total_timeout")), t.totalTimeoutMs);
  let lease: CopyLease | null = null;
  let copyId: string | undefined;
  try {
    const fileSha256 = await sha256Prefixed(bytes);
    const path = originalPath(fileSha256);
    const size = bytes.byteLength;

    const inserted = await db.insertPending(
      { file_sha256: fileSha256, size_bytes: size, detected_mime_type: "application/pdf", storage_path: path },
      total.signal,
    );

    if (inserted) {
      lease = new CopyLease(db, inserted.id, inserted.updated_at, total.signal);
    } else {
      const deadline = now() + t.waitTotalMs;
      for (;;) {
        const row = await db.getByHash(fileSha256, total.signal);
        if (!row) return { status: "failed", errorClass: "copy_row_vanished" };
        copyId = row.id;
        if (row.storage_status === "stored") return { status: "deduplicated", copyId: row.id, fileSha256, sizeBytes: row.size_bytes };
        if (row.storage_status !== "pending") return { status: "failed", errorClass: `copy_state_${row.storage_status}`, copyId: row.id };
        const age = now() - Date.parse(row.updated_at);
        if (age > t.leaseMs) {
          const staleBefore = new Date(now() - t.leaseMs).toISOString();
          const token = await db.fencedUpdate(row.id, row.updated_at, { storage_status: "pending" }, total.signal, staleBefore);
          if (token !== null) {
            lease = new CopyLease(db, row.id, token, total.signal);
            break;
          }
        }
        if (now() >= deadline) return { status: "pending_in_progress", errorClass: "pending_wait_timeout", copyId: row.id };
        await sleep(t.waitPollMs, total.signal);
      }
    }

    if (!lease) return { status: "failed", errorClass: "lease_missing" };
    copyId = lease.copyId;
    lease.startHeartbeat(t.heartbeatMs);

    if (!(await lease.renew())) throw lease.failed ?? new LostOwnership();
    await withTimeout(total.signal, t.uploadTimeoutMs, (s) => store.upload(path, bytes, s));

    if (!(await lease.renew())) throw lease.failed ?? new LostOwnership();
    const verdict = await withTimeout(total.signal, t.verifyTimeoutMs, (s) => verifyObject(store, path, fileSha256, size, s));

    if (verdict === "match") {
      const ok = await lease.finalize({ storage_status: "stored", stored_at: new Date(now()).toISOString() });
      if (!ok) throw lease.failed ?? new LostOwnership();
      return { status: "stored", copyId, fileSha256, sizeBytes: size };
    }
    const ok = await lease.finalize({ storage_status: "conflict" });
    if (!ok) throw lease.failed ?? new LostOwnership();
    return { status: "failed", errorClass: verdict === "missing" ? "verify_object_missing" : "storage_conflict", copyId };
  } catch (e) {
    if (e instanceof LostOwnership) return { status: "pending_in_progress", errorClass: "lost_ownership", copyId };
    if (e instanceof TimeoutError || total.signal.aborted) return { status: "failed", errorClass: "timeout", copyId };
    return { status: "failed", errorClass: classify(e), copyId };
  } finally {
    clearTimeout(totalTimer);
    total.abort(new TimeoutError("finished"));
    if (lease) await lease.stop();
  }
}

function classify(e: unknown): string {
  const m = e instanceof Error ? e.message : "";
  if (/upload/i.test(m)) return "upload_error";
  if (/download|verify/i.test(m)) return "verify_error";
  return "db_error";
}

// ---------------------------------------------------------------- extraction

export type TruncationStatus = "complete" | "truncated" | "unknown";

/**
 * `complete` only when the extractor confirms it processed every page and no
 * cut is signalled; `truncated` only on an explicit sign (fewer processed
 * pages than the document declares, or the extractor reported a cut);
 * otherwise `unknown`. Blank or image-only pages are never proof of truncation.
 */
export function classifyTruncation(info: { totalPages: number; processedPages: number; cutSignalled?: boolean }): TruncationStatus {
  if (info.cutSignalled) return "truncated";
  if (info.totalPages > 0 && info.processedPages < info.totalPages) return "truncated";
  if (info.totalPages > 0 && info.processedPages === info.totalPages) return "complete";
  return "unknown";
}

export type LinkResult = { sighting: "ok" | "failed" | "not_applicable"; extraction: "ok" | "failed" | "not_applicable"; error_class?: string };

/** Inserts the sighting and (only for text from these bytes) the extraction, after raw_items. */
export async function linkAfterRaw(
  input: {
    outcome: OriginalOutcome;
    rawItemId: string | null;
    sourceId: string;
    jobId: string;
    fetchedUrl: string;
    receivedFilename: string | null;
    informedMimeType: string | null;
    declaredSize: number | null;
    extraction: null | { text: string; tool: string; version: string; totalPages: number; processedPages: number };
  },
  deps: StorageDeps,
): Promise<LinkResult> {
  const o = input.outcome;
  const byteOutcome =
    o.status === "stored" ? "stored" : o.status === "deduplicated" ? "deduplicated" : o.status === "not_stored_size_limit" ? "not_stored_size_limit" : null;
  if (!byteOutcome) return { sighting: "not_applicable", extraction: "not_applicable" };
  const copyId = o.status === "stored" || o.status === "deduplicated" ? o.copyId : null;

  const result: LinkResult = { sighting: "not_applicable", extraction: "not_applicable" };
  try {
    await deps.db.insertSighting({
      copy_id: copyId,
      raw_item_id: input.rawItemId,
      source_id: input.sourceId,
      collection_job_id: input.jobId,
      fetched_url: input.fetchedUrl,
      fetch_method: "http",
      received_filename: input.receivedFilename,
      informed_mime_type: input.informedMimeType,
      declared_size_bytes: input.declaredSize,
      byte_outcome: byteOutcome,
      is_manual_recheck: false,
    });
    result.sighting = "ok";
  } catch {
    result.sighting = "failed";
    result.error_class = "sighting_insert_failed";
  }

  if (copyId && input.extraction) {
    try {
      const x = input.extraction;
      const textBytes = new TextEncoder().encode(x.text);
      const textSha = await sha256Prefixed(textBytes);
      let location: { text_inline: string | null; text_storage_path: string | null };
      if (textBytes.byteLength <= MAX_INLINE_TEXT_BYTES) {
        location = { text_inline: x.text, text_storage_path: null };
      } else {
        const p = textPath(textSha);
        const t = { ...DEFAULT_TIMINGS, ...deps.timings };
        const c = new AbortController();
        try {
          await withTimeout(c.signal, t.uploadTimeoutMs, (s) => deps.store.upload(p, textBytes, s));
          const v = await withTimeout(c.signal, t.verifyTimeoutMs, (s) => verifyObject(deps.store, p, textSha, textBytes.byteLength, s));
          if (v !== "match") throw new Error("text verify failed");
        } finally {
          c.abort();
        }
        location = { text_inline: null, text_storage_path: p };
      }
      await deps.db.insertExtraction({
        copy_id: copyId,
        extractor_tool: x.tool,
        extractor_version: x.version,
        text_sha256_exact: textSha,
        char_count: x.text.length,
        page_count_detected: x.totalPages,
        truncation_status: classifyTruncation({ totalPages: x.totalPages, processedPages: x.processedPages }),
        ...location,
      });
      result.extraction = "ok";
    } catch {
      result.extraction = "failed";
      result.error_class = result.error_class ?? "extraction_insert_failed";
    }
  }
  return result;
}

// ---------------------------------------------------------------- real deps

/** Real database + Storage dependencies (service role, server only). */
export async function createStorageDeps(): Promise<StorageDeps> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) throw new Error("storage not configured");
  // The document_* tables may be absent from generated types; use an untyped handle.
  const sb = supabaseAdmin as unknown as {
    from: (t: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const cols = "id, storage_status, updated_at, size_bytes, file_sha256";

  const db: CopiesDb = {
    async insertPending(row, signal) {
      const { data, error } = await sb
        .from("document_copies")
        .upsert({ ...row, storage_bucket: ORIGINALS_BUCKET, storage_status: "pending" }, { onConflict: "file_sha256", ignoreDuplicates: true })
        .select(cols)
        .abortSignal(signal);
      if (error) throw new Error(`db: ${error.code ?? ""}`);
      return (data?.[0] as CopyRow | undefined) ?? null;
    },
    async getByHash(hash, signal) {
      const { data, error } = await sb.from("document_copies").select(cols).eq("file_sha256", hash).abortSignal(signal).maybeSingle();
      if (error) throw new Error(`db: ${error.code ?? ""}`);
      return (data as CopyRow | null) ?? null;
    },
    async fencedUpdate(id, token, patch, signal, staleBefore) {
      let q = sb.from("document_copies").update(patch).eq("id", id).eq("storage_status", "pending").eq("updated_at", token);
      if (staleBefore) q = q.lt("updated_at", staleBefore);
      const { data, error } = await q.select("updated_at").abortSignal(signal);
      if (error) throw new Error(`db: ${error.code ?? ""}`);
      return (data?.[0]?.updated_at as string | undefined) ?? null;
    },
    async insertSighting(row) {
      const { data, error } = await sb.from("document_copy_sightings").insert(row).select("id").single();
      if (error) throw new Error(`db: ${error.code ?? ""}`);
      return data.id as string;
    },
    async insertExtraction(row) {
      const { data, error } = await sb.from("document_extractions").insert(row).select("id").single();
      if (error) throw new Error(`db: ${error.code ?? ""}`);
      return data.id as string;
    },
  };

  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const store: ObjectStore = {
    async upload(path, bytes, signal) {
      const res = await fetch(`${url}/storage/v1/object/${ORIGINALS_BUCKET}/${path}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/octet-stream", "x-upsert": "false" },
        body: bytes as unknown as BodyInit,
        signal,
      });
      if (res.ok) return "created";
      const body = await res.text().catch(() => "");
      if (/"statusCode"\s*:\s*"409"|Duplicate|already exists/i.test(body)) return "exists";
      throw new Error(`upload HTTP ${res.status}`);
    },
    async download(path, signal) {
      const res = await fetch(`${url}/storage/v1/object/${ORIGINALS_BUCKET}/${path}`, { headers, signal });
      if (res.status === 404 || res.status === 400) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
      return res.body;
    },
  };
  return { db, store };
}

// ---------------------------------------------------------------- capped read

export type CappedRead =
  | { kind: "ok"; bytes: Uint8Array; isPdf: boolean }
  | { kind: "over_limit"; bytesRead: number }
  | { kind: "timeout" }
  | { kind: "error"; message: string };

const PDF_SIG = [0x25, 0x50, 0x44, 0x46];

/**
 * Reads a response body counting bytes as they arrive (originals mode only).
 * - Decides "PDF or not" only after at least 4 bytes (signature may be split).
 * - PDF: cancels the read as soon as the total would exceed `cap`, keeping
 *   none of the content. Not a promise that the network delivers no byte past
 *   the cap; only that we stop consuming and do not keep the excess.
 * - Non-PDF: read fully, as before (no cap).
 * - Content-Length is only a sizing hint: the buffer grows when more arrives,
 *   and only the filled range is returned when less arrives.
 * This does not prove that 50 MB fits in Worker memory; that needs measurement.
 */
export async function readBodyCapped(
  res: Response,
  cap: number,
  opts: { timeoutMs: number; declared: number | null; initialCapacity?: number },
): Promise<CappedRead> {
  if (!res.body) return { kind: "ok", bytes: new Uint8Array(0), isPdf: false };
  const reader = res.body.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, opts.timeoutMs);

  const startCap =
    opts.declared !== null && opts.declared > 0 && opts.declared <= cap
      ? opts.declared
      : Math.min(opts.initialCapacity ?? 65_536, cap);
  let buf = new Uint8Array(Math.max(startCap, 4));
  let filled = 0;
  let isPdf: boolean | null = null;

  const ensure = (needed: number, limit: number) => {
    if (needed <= buf.length) return;
    const next = new Uint8Array(Math.min(Math.max(buf.length * 2, needed), limit));
    next.set(buf.subarray(0, filled));
    buf = next;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) return { kind: "timeout" };
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const total = filled + value.byteLength;
      if (isPdf === true && total > cap) {
        await reader.cancel().catch(() => undefined);
        buf = new Uint8Array(0);
        return { kind: "over_limit", bytesRead: total };
      }
      if (isPdf === null && total > cap) {
        // Undecided yet: decide on what we have plus this chunk's head.
        const head = new Uint8Array(4);
        head.set(buf.subarray(0, Math.min(filled, 4)));
        if (filled < 4) head.set(value.subarray(0, 4 - filled), filled);
        if (PDF_SIG.every((b, i) => head[i] === b)) {
          await reader.cancel().catch(() => undefined);
          buf = new Uint8Array(0);
          return { kind: "over_limit", bytesRead: total };
        }
        isPdf = false;
      }
      ensure(total, isPdf === false ? Number.MAX_SAFE_INTEGER : cap);
      buf.set(value, filled);
      filled = total;
      if (isPdf === null && filled >= 4) isPdf = PDF_SIG.every((b, i) => buf[i] === b);
    }
    if (timedOut) return { kind: "timeout" };
    return { kind: "ok", bytes: buf.subarray(0, filled), isPdf: isPdf === true };
  } catch (e) {
    if (timedOut) return { kind: "timeout" };
    return { kind: "error", message: (e as Error).message.slice(0, 200) };
  } finally {
    clearTimeout(timer);
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}
