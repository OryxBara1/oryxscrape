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

export const listDiscoveryCandidates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertStaff(context.supabase);
    const db = context.supabase as Db;
    const { data, error } = await db
      .from("discovery_candidates")
      .select(
        "id, found_at, found_title, found_identifier, found_url, country_code, issuing_authority, language, doc_type_guess, confidence, stage, outcome, provider, discovery_sightings(count)",
      )
      .eq("provider", LDH_PROVIDER)
      .order("found_at", { ascending: false })
      .limit(200);
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
        confidence: Object.keys((r["confidence"] as Record<string, string>) ?? {}).length ? "hypothesis" : "—",
        sightings: ((r["discovery_sightings"] as { count: number }[] | null)?.[0]?.count ?? 0) as number,
      })),
    };
  });
