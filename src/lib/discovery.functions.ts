import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import {
  LDH_PROVIDER,
  QUOTA_NOTE,
  runLdhSearchCore,
  validateSearchInput,
  type DiscoveryStore,
} from "./ldh-discovery.server";
import {
  triageCore,
  validateTriageInput,
  type CandidateState,
  type TriageStore,
  type TriageResult,
} from "./discovery-triage";

// Untyped handle: only the columns used here; RLS applies as the signed-in user.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any>;

async function assertStaff(supabase: SupabaseClient<Database>) {
  const { data, error } = await supabase.rpc("is_staff");
  if (error || data !== true) throw new Error("Forbidden: staff only.");
}

function fail(op: string, error: { code?: string } | null): never {
  // fixed code only — never provider text
  throw new Error(`discovery_db_${op}${error?.code ? `_${error.code}` : ""}`);
}

export function supabaseDiscoveryStore(db: Db): DiscoveryStore {
  return {
    async expireStaleRuns(provider, cutoffIso) {
      const now = new Date().toISOString();
      const { error } = await db
        .from("discovery_runs")
        .update({ status: "interrupted", error_code: "stale_heartbeat", finished_at: now })
        .eq("provider", provider)
        .eq("status", "running")
        .lt("heartbeat_at", cutoffIso);
      if (error) fail("expire", error);
    },
    async createRun(provider, userId) {
      const { data, error } = await db
        .from("discovery_runs")
        .insert({ provider, status: "running", triggered_by: userId })
        .select("id")
        .single();
      if (error?.code === "23505") return { busy: true };
      if (error || !data) fail("create_run", error);
      return { id: data.id as string };
    },
    async countCountedSince(provider, sinceIso) {
      const { count, error } = await db
        .from("discovery_queries")
        .select("id, discovery_runs!inner(provider)", { count: "exact", head: true })
        .eq("counted_against_budget", true)
        .eq("discovery_runs.provider", provider)
        .gte("sent_at", sinceIso);
      if (error) fail("count", error);
      return count ?? 0;
    },
    async reserveQuery(runId, input, sentAtIso) {
      const { data, error } = await db
        .from("discovery_queries")
        .insert({
          run_id: runId,
          purpose: "new",
          query_text: input.q,
          param_country: input.country ?? null,
          param_language: input.language ?? null,
          param_namespace: input.namespace,
          status: "sent",
          attempt: 1,
          counted_against_budget: true,
          sent_at: sentAtIso,
        })
        .select("id")
        .single();
      if (error || !data) fail("reserve", error);
      const { error: e2 } = await db
        .from("discovery_runs")
        .update({ calls_reserved: 1, calls_used: 1, heartbeat_at: sentAtIso })
        .eq("id", runId);
      if (e2) fail("reserve_run", e2);
      return data.id as string;
    },
    async finishQuery(queryId, patch) {
      const { error } = await db.from("discovery_queries").update(patch).eq("id", queryId);
      if (error) fail("finish_query", error);
    },
    async finishRun(runId, patch) {
      const { error } = await db.from("discovery_runs").update(patch).eq("id", runId);
      if (error) fail("finish_run", error);
    },
    async findByKeys(keys) {
      const ors: string[] = [];
      // values double-quoted for PostgREST `or` syntax
      const q = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      if (keys.provider) ors.push(`key_provider.eq.${q(keys.provider)}`);
      if (keys.identifier) ors.push(`key_identifier.eq.${q(keys.identifier)}`);
      if (keys.url) ors.push(`key_url.eq.${q(keys.url)}`);
      if (ors.length === 0) return [];
      const { data, error } = await db
        .from("discovery_candidates")
        .select("id, key_provider, key_identifier, key_url")
        .or(ors.join(","));
      if (error) fail("find", error);
      return data ?? [];
    },
    async insertCandidate(row) {
      const { data, error } = await db.from("discovery_candidates").insert(row).select("id").single();
      if (error?.code === "23505") return { uniqueViolation: true };
      if (error || !data) fail("insert_candidate", error);
      return { id: data.id as string };
    },
    async insertSighting(row) {
      const { error } = await db.from("discovery_sightings").insert(row);
      if (error) fail("insert_sighting", error);
    },
  };
}

export const runLdhSearch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => validateSearchInput(input))
  .handler(async ({ data, context }) => {
    await assertStaff(context.supabase);
    return runLdhSearchCore(data, {
      store: supabaseDiscoveryStore(context.supabase as Db),
      userId: context.userId,
      apiKey: process.env["LDH_API_KEY"],
      log: (code, info) => console.info("[ldh]", code, info ?? {}),
    });
  });

type ListFilters = { stage?: string | undefined; outcome?: string | undefined; country?: string | undefined };
const STAGES = ["lead", "identified", "source_located", "approved_for_collection", "collected", "reviewed_copy"];
const OUTCOMES = ["open", "out_of_scope", "rejected", "duplicate"];

export const listDiscoveryCandidates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown): ListFilters => {
    const r = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const pick = (v: unknown, ok: (s: string) => boolean) => (typeof v === "string" && ok(v) ? v : undefined);
    return {
      stage: pick(r["stage"], (s) => STAGES.includes(s)),
      outcome: pick(r["outcome"], (s) => OUTCOMES.includes(s)),
      country: pick(r["country"], (s) => /^[A-Z]{2}$/.test(s)),
    };
  })
  .handler(async ({ data: f, context }) => {
    await assertStaff(context.supabase);
    const db = context.supabase as Db;
    let q = db
      .from("discovery_candidates")
      .select(
        "id, found_at, found_title, found_identifier, found_url, country_code, issuing_authority, language, doc_type_guess, confidence, stage, outcome, needs_review, provider, discovery_sightings(count)",
      )
      .eq("provider", LDH_PROVIDER);
    if (f.stage) q = q.eq("stage", f.stage);
    if (f.outcome) q = q.eq("outcome", f.outcome);
    if (f.country) q = q.eq("country_code", f.country);
    const { data, error } = await q.order("found_at", { ascending: false }).limit(200);
    if (error) throw new Error("Could not load discovery candidates.");
    return {
      quotaNote: QUOTA_NOTE,
      rows: (data ?? []).map((r: Record<string, unknown>) => ({
        id: r["id"] as string,
        found_at: r["found_at"] as string,
        found_title: (r["found_title"] as string | null) ?? null,
        found_identifier: (r["found_identifier"] as string | null) ?? null,
        found_url: (r["found_url"] as string | null) ?? null,
        country_code: (r["country_code"] as string | null) ?? null,
        issuing_authority: (r["issuing_authority"] as string | null) ?? null,
        language: (r["language"] as string | null) ?? null,
        doc_type_guess: (r["doc_type_guess"] as string | null) ?? null,
        stage: r["stage"] as string,
        outcome: r["outcome"] as string,
        needs_review: r["needs_review"] === true,
        confidence: Object.keys((r["confidence"] as Record<string, string>) ?? {}).length ? "hypothesis" : "—",
        sightings: ((r["discovery_sightings"] as { count: number }[] | null)?.[0]?.count ?? 0) as number,
      })),
    };
  });

const CANDIDATE_DETAIL_COLS =
  "id, provider, provider_source, provider_source_id, found_at, found_title, found_identifier, found_url, country_code, issuing_authority, language, doc_type_guess, stage, outcome, outcome_reason, outcome_history, needs_review, review_note, reviewed_by, reviewed_at, updated_at";

export const getDiscoveryCandidate = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const id = (input as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid candidate id.");
    return { id };
  })
  .handler(async ({ data, context }) => {
    await assertStaff(context.supabase);
    const db = context.supabase as Db;
    const { data: c, error } = await db.from("discovery_candidates").select(CANDIDATE_DETAIL_COLS).eq("id", data.id).maybeSingle();
    if (error) throw new Error("Could not load candidate.");
    // updated_at is returned exactly as the DB sent it; the browser passes it back unchanged as the compare token.
    const candidate = (c ?? null) as CandidateDetail | null;
    if (!candidate) return { candidate: null, sightings: [] as Sighting[] };
    const { data: s, error: se } = await db
      .from("discovery_sightings")
      .select("id, matched_key, seen_url, seen_at")
      .eq("candidate_id", data.id)
      .order("seen_at", { ascending: true });
    if (se) throw new Error("Could not load sightings.");
    return { candidate, sightings: (s ?? []) as Sighting[] };
  });

type S = string | null;
export type CandidateDetail = {
  id: string; provider: string; provider_source: S; provider_source_id: S; found_at: string;
  found_title: S; found_identifier: S; found_url: S; country_code: S; issuing_authority: S;
  language: S; doc_type_guess: S; stage: string; outcome: string; outcome_reason: S;
  outcome_history: { from: S; to: S; from_reason: S; to_reason: S; by: S; at: S }[];
  needs_review: boolean; review_note: S; reviewed_by: S; reviewed_at: S; updated_at: string;
};
type Sighting = { id: string; matched_key: string; seen_url: string | null; seen_at: string };

export function supabaseTriageStore(db: Db, supabase: SupabaseClient<Database>): TriageStore {
  return {
    async isStaff() {
      const { data, error } = await supabase.rpc("is_staff");
      return !error && data === true;
    },
    async read(id) {
      const { data, error } = await db
        .from("discovery_candidates")
        .select("id, outcome, needs_review, updated_at")
        .eq("id", id)
        .maybeSingle();
      if (error) fail("triage_read", error);
      return (data as CandidateState | null) ?? null;
    },
    async update(id, guard, patch) {
      const { data, error } = await db
        .from("discovery_candidates")
        .update(patch)
        .eq("id", id)
        .eq("outcome", guard.outcome)
        .eq("updated_at", guard.updated_at)
        .select("id");
      if (error) fail("triage_update", error);
      return (data ?? []).length;
    },
  };
}

export const triageDiscoveryCandidate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => validateTriageInput(input))
  .handler(async ({ data, context }): Promise<TriageResult> =>
    triageCore(data, {
      store: supabaseTriageStore(context.supabase as Db, context.supabase),
      userId: context.userId,
      now: () => new Date(),
    }),
  );
