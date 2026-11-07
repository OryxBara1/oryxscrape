import { describe, expect, it } from "vitest";

import { triageCore, validateTriageInput, type CandidateState, type TriagePatch, type TriageStore } from "./discovery-triage";

const ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "2026-11-06T10:40:48.123456+00:00";
const NOW = new Date("2026-11-07T00:00:00.000Z");

function mockStore(init: Partial<CandidateState> = {}, staff = true) {
  const row: CandidateState & Record<string, unknown> = {
    id: ID, outcome: "open", needs_review: false, updated_at: TOKEN,
    found_url: "https://x.mt/a", stage: "lead", outcome_history: [], ...init,
  };
  const writes: TriagePatch[] = [];
  let ver = 0;
  const store: TriageStore = {
    isStaff: async () => staff,
    read: async () => ({ id: row.id, outcome: row.outcome, needs_review: row.needs_review, updated_at: row.updated_at }),
    update: async (_id, guard, patch) => {
      if (guard.outcome !== row.outcome || guard.updated_at !== row.updated_at) return 0;
      writes.push(patch);
      Object.assign(row, patch);
      row.updated_at = `2026-11-07T00:00:0${++ver}.000001+00:00`;
      return 1;
    },
  };
  return { store, row, writes };
}

const inp = (o: Record<string, unknown>) =>
  validateTriageInput({ id: ID, expectedOutcome: "open", expectedUpdatedAt: TOKEN, ...o });
const run = (s: TriageStore, i: ReturnType<typeof inp>) => triageCore(i, { store: s, userId: "staff-user", now: () => NOW });

describe("discovery triage", () => {
  it("staff can reject with a reason; patch holds only allowed columns", async () => {
    const m = mockStore();
    expect(await run(m.store, inp({ action: "reject", text: "  not maritime  " }))).toEqual({ ok: true });
    expect(m.writes).toEqual([{ outcome: "rejected", outcome_reason: "not maritime", reviewed_by: "staff-user", reviewed_at: NOW.toISOString() }]);
    expect(m.row["found_url"]).toBe("https://x.mt/a");
    expect(m.row["stage"]).toBe("lead");
    expect(m.row["outcome_history"]).toEqual([]);
  });

  it("non-staff is refused before any read or write", async () => {
    const m = mockStore({}, false);
    await expect(run(m.store, inp({ action: "reject", text: "reason" }))).rejects.toThrow(/staff/);
    expect(m.writes).toHaveLength(0);
  });

  it("reason must be 3–500 chars after trim", () => {
    expect(() => inp({ action: "reject", text: "  ab " })).toThrow();
    expect(() => inp({ action: "out_of_scope" })).toThrow();
    expect(() => inp({ action: "reopen", text: "x".repeat(501) })).toThrow();
    expect(inp({ action: "out_of_scope", text: "abc" }).text).toBe("abc");
  });

  it("note is mandatory and ≤500 for flag_review", () => {
    expect(() => inp({ action: "flag_review", text: "   " })).toThrow();
    expect(() => inp({ action: "flag_review", text: "y".repeat(501) })).toThrow();
  });

  it("stale updated_at is rejected with no write", async () => {
    const m = mockStore();
    const r = await run(m.store, inp({ action: "reject", text: "reason", expectedUpdatedAt: "2026-11-06T10:40:48.123+00:00" }));
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(m.writes).toHaveLength(0);
  });

  it("stale outcome is rejected with no write", async () => {
    const m = mockStore({ outcome: "rejected" });
    const r = await run(m.store, inp({ action: "reject", text: "reason" }));
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(m.writes).toHaveLength(0);
  });

  it("two note edits from the same original state: second gets conflict", async () => {
    const m = mockStore();
    const a = inp({ action: "flag_review", text: "note A" });
    const b = inp({ action: "flag_review", text: "note B" });
    expect(await run(m.store, a)).toEqual({ ok: true });
    expect(await run(m.store, b)).toMatchObject({ ok: false, code: "conflict" });
    expect(m.writes).toHaveLength(1);
    expect(m.row["review_note"]).toBe("note A");
  });

  it("guarded update returning 0 rows is reported as conflict, not retried", async () => {
    const m = mockStore();
    let calls = 0;
    m.store.update = async () => { calls++; return 0; };
    expect(await run(m.store, inp({ action: "reject", text: "reason" }))).toMatchObject({ code: "conflict" });
    expect(calls).toBe(1);
  });

  it("reviewer identity cannot be set by the browser", async () => {
    const m = mockStore();
    const i = validateTriageInput({
      id: ID, action: "reject", text: "reason", expectedOutcome: "open", expectedUpdatedAt: TOKEN,
      reviewed_by: "attacker", reviewed_at: "1999-01-01", stage: "collected", found_url: "https://evil",
    });
    expect(Object.keys(i).sort()).toEqual(["action", "expectedOutcome", "expectedUpdatedAt", "id", "text"]);
    await run(m.store, i);
    expect(m.writes[0]).toMatchObject({ reviewed_by: "staff-user", reviewed_at: NOW.toISOString() });
    expect(m.row["stage"]).toBe("lead");
    expect(m.row["found_url"]).toBe("https://x.mt/a");
  });

  it("reopen only from rejected/out_of_scope, with reason", async () => {
    const m = mockStore({ outcome: "out_of_scope" });
    expect(await run(m.store, inp({ action: "reopen", text: "re-check", expectedOutcome: "out_of_scope" }))).toEqual({ ok: true });
    expect(m.writes[0]).toMatchObject({ outcome: "open", outcome_reason: "re-check" });
    const o = mockStore();
    expect(await run(o.store, inp({ action: "reopen", text: "re-check" }))).toMatchObject({ code: "invalid_transition" });
    const d = mockStore({ outcome: "duplicate" });
    expect(await run(d.store, inp({ action: "reopen", text: "re-check", expectedOutcome: "duplicate" }))).toMatchObject({ code: "invalid_transition" });
    expect(o.writes.length + d.writes.length).toBe(0);
  });

  it("reject not allowed from a decided state", async () => {
    const m = mockStore({ outcome: "rejected" });
    expect(await run(m.store, inp({ action: "out_of_scope", text: "reason", expectedOutcome: "rejected" }))).toMatchObject({ code: "invalid_transition" });
  });

  it("clear_review only when flagged; outcome untouched", async () => {
    const m = mockStore({ needs_review: true });
    expect(await run(m.store, inp({ action: "clear_review" }))).toEqual({ ok: true });
    expect(m.writes[0]).toEqual({ needs_review: false, reviewed_by: "staff-user", reviewed_at: NOW.toISOString() });
    expect(m.row.outcome).toBe("open");
    const n = mockStore();
    expect(await run(n.store, inp({ action: "clear_review" }))).toMatchObject({ code: "invalid_transition" });
  });

  it("unknown actions (duplicate, stage changes) are refused", () => {
    expect(() => inp({ action: "duplicate", text: "x" })).toThrow();
    expect(() => inp({ action: "approve_for_collection" })).toThrow();
  });
});
