// LDH (Legal Data Hunter) discovery — thin manual slice.
// Only POST /v1/search is ever called. Provider text (snippet/summary/text),
// score, raw bodies, headers and the key are never persisted, logged or returned.

export const LDH_PROVIDER = "ldh";
export const LDH_SEARCH_URL = "https://legaldatahunter.com/v1/search";
export const LDH_TOP_K = 10;
export const LDH_TIMEOUT_MS = 30_000;
export const STALE_RUN_MS = 120_000; // 4x the request timeout
export const QUOTA_24H = 20;
export const QUOTA_30D = 600;
export const QUOTA_NOTE =
  "Quota counter is local only: it does not include LDH requests made outside this app (e.g. MCP clients on the same account), so LDH may answer 429 earlier. A 429 is a counted failure and is never retried.";

export type Namespace = "legislation" | "case_law" | "doctrine";
export type SearchInput = {
  q: string;
  namespace: Namespace;
  country?: string;
  language?: string;
  date_start?: string;
  date_end?: string;
};

const RE = {
  country: /^[A-Z]{2}$/,
  language: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  providerSource: /^[A-Za-z0-9_.:-]{1,100}$/,
  providerSourceId: /^[A-Za-z0-9_.:/-]{1,200}$/,
  authority: /^[a-z0-9_.-]{2,60}$/,
};

export function validateSearchInput(input: unknown): SearchInput {
  const i = (input ?? {}) as Record<string, unknown>;
  const q = typeof i["q"] === "string" ? i["q"].trim() : "";
  if (q.length < 1 || q.length > 500) throw new Error("Query must be 1–500 characters.");
  if (!["legislation", "case_law", "doctrine"].includes(i["namespace"] as string))
    throw new Error("Unknown namespace.");
  const out: SearchInput = { q, namespace: i["namespace"] as Namespace };
  const opt = (k: "country" | "language" | "date_start" | "date_end", re: RegExp) => {
    const v = i[k];
    if (v === undefined || v === null || v === "") return;
    if (typeof v !== "string" || !re.test(v)) throw new Error(`Invalid ${k}.`);
    out[k] = v;
  };
  opt("country", RE.country);
  opt("language", RE.language);
  opt("date_start", RE.date);
  opt("date_end", RE.date);
  return out;
}

export function buildSearchBody(input: SearchInput): Record<string, unknown> {
  const body: Record<string, unknown> = { q: input.q, namespace: input.namespace, top_k: LDH_TOP_K };
  if (input.country) body["country"] = [input.country];
  if (input.language) body["language"] = input.language;
  if (input.date_start) body["date_start"] = input.date_start;
  if (input.date_end) body["date_end"] = input.date_end;
  return body;
}

export type CandidateRow = {
  provider: string;
  provider_source: string | null;
  provider_source_id: string | null;
  found_url: string | null;
  found_title: string | null;
  found_identifier: string | null;
  country_code: string | null;
  issuing_authority: string | null;
  language: string | null;
  doc_type_guess: string | null;
  confidence: Record<string, "hypothesis">;
  key_provider: string | null;
  key_identifier: string | null;
  key_url: string | null;
};

export type MappedHit = { ok: true; row: CandidateRow } | { ok: false; reason: string };

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
const fit = (v: string | null, max: number) => (v !== null && v.length <= max ? v : null);
const match = (v: string | null, re: RegExp) => (v !== null && re.test(v) ? v : null);

/** Allowlist mapping. Values are stored as-is or dropped; never rewritten. */
export function mapHit(hit: unknown): MappedHit {
  if (!hit || typeof hit !== "object") return { ok: false, reason: "not_an_object" };
  const h = hit as Record<string, unknown>;
  let source = match(str(h["source"]), RE.providerSource);
  let sourceId = match(str(h["source_id"]), RE.providerSourceId);
  if (!source || !sourceId) source = sourceId = null;

  const url = fit(str(h["url"]), 4000);
  const title = fit(str(h["title"]), 500);
  const identifier = fit(str(h["identifier"]), 300);
  const country = match(str(h["country"]), RE.country);
  const authority = match(str(h["authority"]), RE.authority);
  const language = match(str(h["language"]), RE.language);
  const docType = fit(str(h["document_type"]), 80);

  if (!url && !title && !identifier) return { ok: false, reason: "no_url_title_or_identifier" };

  const keyProvider = source && sourceId ? `prov:${LDH_PROVIDER}:${source.toLowerCase()}:${sourceId}` : null;
  const keyIdCandidate =
    country && authority && identifier ? `id:${country}:${authority}:${identifier}` : null;
  const keyIdentifier = keyIdCandidate && keyIdCandidate.length <= 400 ? keyIdCandidate : null;
  const keyUrl = url && /^https:\/\/[^/?#\s]+/.test(url) ? `url:${url}` : null;
  if (!keyProvider && !keyIdentifier && !keyUrl) return { ok: false, reason: "no_valid_dedup_key" };

  const confidence: Record<string, "hypothesis"> = {};
  if (title) confidence["title"] = "hypothesis";
  if (identifier) confidence["identifier"] = "hypothesis";
  if (url) confidence["url"] = "hypothesis";
  if (country) confidence["country"] = "hypothesis";
  if (authority) confidence["authority"] = "hypothesis";
  if (language) confidence["language"] = "hypothesis";
  if (docType) confidence["doc_type"] = "hypothesis";

  return {
    ok: true,
    row: {
      provider: LDH_PROVIDER,
      provider_source: source,
      provider_source_id: sourceId,
      found_url: url,
      found_title: title,
      found_identifier: identifier,
      country_code: country,
      issuing_authority: authority,
      language,
      doc_type_guess: docType,
      confidence,
      key_provider: keyProvider,
      key_identifier: keyIdentifier,
      key_url: keyUrl,
    },
  };
}

export type ExistingCandidate = {
  id: string;
  key_provider: string | null;
  key_identifier: string | null;
  key_url: string | null;
};

export type DedupDecision =
  | { kind: "new" }
  | { kind: "sighting"; candidateId: string; matchedKey: "provider" | "identifier" | "url" }
  | { kind: "conflict"; candidateIds: string[] };

export function decideDedup(row: CandidateRow, existing: ExistingCandidate[]): DedupDecision {
  const hits: { key: "provider" | "identifier" | "url"; id: string }[] = [];
  for (const c of existing) {
    if (row.key_provider && c.key_provider === row.key_provider) hits.push({ key: "provider", id: c.id });
    if (row.key_identifier && c.key_identifier === row.key_identifier)
      hits.push({ key: "identifier", id: c.id });
    if (row.key_url && c.key_url === row.key_url) hits.push({ key: "url", id: c.id });
  }
  if (hits.length === 0) return { kind: "new" };
  const ids = [...new Set(hits.map((h) => h["id"]))];
  if (ids.length > 1) return { kind: "conflict", candidateIds: ids.sort() };
  const order = ["provider", "identifier", "url"] as const;
  const matchedKey = order.find((k) => hits.some((h) => h["key"] === k))!;
  return { kind: "sighting", candidateId: ids[0]!, matchedKey };
}

// ---------- persistence port (implemented with the user's RLS client) ----------
export interface DiscoveryStore {
  expireStaleRuns(provider: string, cutoffIso: string): Promise<void>;
  createRun(provider: string, userId: string): Promise<{ id: string } | { busy: true }>;
  countCountedSince(provider: string, sinceIso: string): Promise<number>;
  reserveQuery(runId: string, input: SearchInput, sentAtIso: string): Promise<string>;
  finishQuery(queryId: string, patch: Record<string, unknown>): Promise<void>;
  finishRun(runId: string, patch: Record<string, unknown>): Promise<void>;
  findByKeys(keys: { provider?: string; identifier?: string; url?: string }): Promise<ExistingCandidate[]>;
  insertCandidate(
    row: CandidateRow & { run_id: string; query_id: string },
  ): Promise<{ id: string } | { uniqueViolation: true }>;
  insertSighting(row: {
    candidate_id: string;
    run_id: string;
    query_id: string;
    provider: string;
    matched_key: string;
    seen_url: string | null;
  }): Promise<void>;
}

export type RunResult = {
  runId: string | null;
  status: string;
  errorCode?: string | undefined;
  httpStatus?: number;
  hitsReturned: number;
  created: number;
  sighted: number;
  unusable: { index: number; reason: string }[];
  conflicts: { index: number; candidateIds: string[] }[];
  quota: { used24h: number; used30d: number; limit24h: number; limit30d: number; localOnly: true };
  quotaNote: string;
};

type Deps = {
  store: DiscoveryStore;
  userId: string;
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (code: string, info?: Record<string, string | number>) => void;
  timeoutMs?: number;
};

function classify(status: number): { kind: string; code: string } {
  if (status === 401 || status === 403) return { kind: "auth", code: "ldh_auth" };
  if (status === 429) return { kind: "rate_limit", code: "ldh_rate_limit" };
  if (status >= 400 && status < 500) return { kind: "bad_request", code: "ldh_bad_request" };
  return { kind: "server", code: "ldh_server" };
}

export async function runLdhSearchCore(input: SearchInput, deps: Deps): Promise<RunResult> {
  const { store, userId } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const quota = { used24h: 0, used30d: 0, limit24h: QUOTA_24H, limit30d: QUOTA_30D, localOnly: true as const };
  const base = (runId: string | null, status: string, errorCode?: string): RunResult => ({
    runId, status, errorCode, hitsReturned: 0, created: 0, sighted: 0, unusable: [], conflicts: [], quota, quotaNote: QUOTA_NOTE,
  });

  if (!deps.apiKey) {
    log("ldh_config_missing");
    return base(null, "failed", "config_missing");
  }

  // 1. expire stale runs (only those whose heartbeat is older than the expiry)
  await store.expireStaleRuns(LDH_PROVIDER, new Date(now() - STALE_RUN_MS).toISOString());

  // 2. exclusivity first
  const run = await store.createRun(LDH_PROVIDER, userId);
  if ("busy" in run) return base(null, "busy", "run_in_progress");
  const runId = run.id;
  const finish = (patch: Record<string, unknown>) =>
    store.finishRun(runId, { ...patch, finished_at: new Date(now()).toISOString(), heartbeat_at: new Date(now()).toISOString() });

  // 3. quota (stricter of both windows)
  quota.used24h = await store.countCountedSince(LDH_PROVIDER, new Date(now() - 86_400_000).toISOString());
  quota.used30d = await store.countCountedSince(LDH_PROVIDER, new Date(now() - 30 * 86_400_000).toISOString());
  const over = quota.used24h >= QUOTA_24H ? "quota_24h" : quota.used30d >= QUOTA_30D ? "quota_30d" : null;
  if (over) {
    await finish({ status: "budget_exhausted", error_code: over });
    return base(runId, "budget_exhausted", over);
  }

  // 4. reserve and count BEFORE dispatch
  const queryId = await store.reserveQuery(runId, input, new Date(now()).toISOString());
  quota.used24h += 1;
  quota.used30d += 1;

  // 5. dispatch once, no retry
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? LDH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(LDH_SEARCH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildSearchBody(input)),
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(timer);
    const timedOut = ctrl.signal.aborted;
    const code = timedOut ? "ldh_timeout" : "ldh_network";
    log(code);
    await store.finishQuery(queryId, { status: "failed", error_kind: timedOut ? "timeout" : "network", error_code: code });
    await finish({ status: "failed", error_code: code });
    return base(runId, "failed", code);
  }

  if (!res.ok) {
    clearTimeout(timer);
    void res.body?.cancel().catch(() => undefined);
    const c = classify(res.status);
    log(c.code, { http_status: res.status });
    const patch: Record<string, unknown> = { status: "failed", http_status: res.status, error_kind: c.kind, error_code: c.code };
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      if (Number.isFinite(ra) && ra > 0) patch["retry_after"] = new Date(now() + ra * 1000).toISOString();
    }
    await store.finishQuery(queryId, patch);
    await finish({ status: "failed", error_code: c.code });
    return { ...base(runId, "failed", c.code), httpStatus: res.status };
  }

  let hits: unknown[];
  try {
    const json = (await res.json()) as { hits?: unknown };
    if (!Array.isArray(json?.hits)) throw new Error("shape");
    hits = json.hits;
  } catch {
    clearTimeout(timer);
    log("ldh_parse", { http_status: res.status });
    await store.finishQuery(queryId, { status: "failed", http_status: res.status, error_kind: "parse", error_code: "ldh_parse" });
    await finish({ status: "failed", error_code: "ldh_parse" });
    return { ...base(runId, "failed", "ldh_parse"), httpStatus: res.status };
  }
  clearTimeout(timer);

  const result: RunResult = { ...base(runId, "succeeded"), httpStatus: res.status, hitsReturned: hits.length };
  for (let index = 0; index < hits.length; index++) {
    const mapped = mapHit(hits[index]);
    if (!mapped.ok) {
      result.unusable.push({ index, reason: mapped.reason });
      continue;
    }
    const row = mapped.row;
    const keys = {
      ...(row.key_provider ? { provider: row.key_provider } : {}),
      ...(row.key_identifier ? { identifier: row.key_identifier } : {}),
      ...(row.key_url ? { url: row.key_url } : {}),
    };
    let decision = decideDedup(row, await store.findByKeys(keys));
    if (decision.kind === "new") {
      const ins = await store.insertCandidate({ ...row, run_id: runId, query_id: queryId });
      if ("id" in ins) {
        result.created++;
        continue;
      }
      // concurrent insert won the unique index: resolve once by lookup
      decision = decideDedup(row, await store.findByKeys(keys));
      if (decision.kind === "new") {
        result.unusable.push({ index, reason: "unique_violation_unresolved" });
        continue;
      }
    }
    if (decision.kind === "conflict") {
      result.conflicts.push({ index, candidateIds: decision.candidateIds });
      continue;
    }
    await store.insertSighting({
      candidate_id: decision.candidateId,
      run_id: runId,
      query_id: queryId,
      provider: LDH_PROVIDER,
      matched_key: decision.matchedKey,
      seen_url: row.found_url,
    });
    result.sighted++;
  }

  await store.finishQuery(queryId, { status: "succeeded", http_status: res.status, result_count: hits.length });
  const skipped = result.unusable.length + result.conflicts.length > 0;
  result.status = skipped ? "partial" : "succeeded";
  await finish(skipped ? { status: "partial", error_code: "hits_skipped" } : { status: "succeeded" });
  log("ldh_search_done", { hits: hits.length, created: result.created, sighted: result.sighted });
  return result;
}
