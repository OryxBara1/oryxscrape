import { describe, expect, it, vi } from "vitest";

import {
  approveCore, initialProposal, validateApproveInput, validateWithdrawInput, withdrawCore,
  type ApprovalState, type ApprovalStore,
} from "./discovery-approval";

const ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "2026-11-06T10:40:48.123456+00:00";
const NOW = new Date("2026-11-07T01:00:00.000Z");
const URL_ = "https://legislation.mt/eli/cap/234/eng?x=1&y=2";

function mockStore(init: Partial<ApprovalState> = {}, staff = true) {
  const row: ApprovalState = {
    id: ID, outcome: "open", stage: "lead", needs_review: false, updated_at: TOKEN,
    confidence: { country: "hypothesis", authority: "hypothesis", title: "hypothesis" }, ...init,
  };
  const writes: Record<string, unknown>[] = [];
  const store: ApprovalStore = {
    isStaff: vi.fn(async () => staff),
    read: vi.fn(async () => ({ ...row })),
    update: vi.fn(async (_id, g, patch) => {
      if (g.outcome !== row.outcome || g.stage !== row.stage || g.updated_at !== row.updated_at) return 0;
      writes.push(patch as Record<string, unknown>);
      Object.assign(row, patch);
      row.updated_at = "2026-11-07T01:00:01.000001+00:00";
      return 1;
    }),
  };
  return { store, row, writes };
}
const deps = (s: ApprovalStore) => ({ store: s, userId: "staff-user", now: () => NOW });
const ap = (o: Record<string, unknown> = {}) =>
  validateApproveInput({
    id: ID, expectedOutcome: "open", expectedStage: "lead", expectedUpdatedAt: TOKEN,
    title: "Merchant Shipping Act", identifier: "Cap. 234", sourceUrl: URL_,
    confirm: { title: true, identifier: false, url: true }, ...o,
  });
const wdIn = (o: Record<string, unknown> = {}) =>
  validateWithdrawInput({ id: ID, expectedOutcome: "open", expectedStage: "approved_for_collection", expectedUpdatedAt: TOKEN, confirmed: true, ...o });

describe("approve for collection", () => {
  it("approves lead -> approved_for_collection in one update; patch keys exactly allowed; URL kept exactly", async () => {
    const m = mockStore();
    expect(await approveCore(ap(), deps(m.store))).toEqual({ ok: true });
    expect(m.writes).toHaveLength(1);
    expect(Object.keys(m.writes[0]!).sort()).toEqual(
      ["confidence", "confirmed_identifier", "confirmed_source_url", "confirmed_title", "reviewed_at", "reviewed_by", "stage"],
    );
    expect(m.writes[0]).toMatchObject({ stage: "approved_for_collection", confirmed_source_url: URL_, confirmed_identifier: null });
  });

  it("also approves from identified and source_located", async () => {
    for (const stage of ["identified", "source_located"]) {
      const m = mockStore({ stage });
      expect(await approveCore(ap({ expectedStage: stage }), deps(m.store))).toEqual({ ok: true });
    }
  });

  it("preserves other confidence keys; only confirmed keys become confirmed", async () => {
    const m = mockStore();
    await approveCore(ap(), deps(m.store));
    expect(m.writes[0]!["confidence"]).toEqual({ country: "hypothesis", authority: "hypothesis", title: "confirmed", url: "confirmed" });
  });

  it.each([
    ["no title/identifier confirmed", { confirm: { title: false, identifier: false, url: true } }],
    ["url not confirmed", { confirm: { title: true, identifier: false, url: false } }],
    ["missing url", { sourceUrl: "" }],
    ["http url", { sourceUrl: "http://legislation.mt/x" }],
    ["url with surrounding space (not rewritten)", { sourceUrl: ` ${URL_}` }],
    ["missing title", { title: "", confirm: { title: true, identifier: false, url: true } }],
    ["confirm flags absent", { confirm: undefined }],
  ])("refuses without write: %s", async (_n, o) => {
    const m = mockStore();
    const r = await approveCore(ap(o), deps(m.store));
    expect(r).toMatchObject({ ok: false, code: "requirements" });
    expect(m.store.update).not.toHaveBeenCalled();
  });

  it("refuses closed outcome and needs_review=true", async () => {
    const a = mockStore({ outcome: "rejected" });
    expect(await approveCore(ap({ expectedOutcome: "rejected" }), deps(a.store))).toMatchObject({ code: "requirements" });
    const b = mockStore({ needs_review: true });
    expect(await approveCore(ap(), deps(b.store))).toMatchObject({ code: "requirements" });
    expect(a.store.update).not.toHaveBeenCalled();
    expect(b.store.update).not.toHaveBeenCalled();
  });

  it("refuses from collected stage", async () => {
    const m = mockStore({ stage: "collected" });
    expect(await approveCore(ap({ expectedStage: "collected" }), deps(m.store))).toMatchObject({ code: "requirements" });
    expect(m.store.update).not.toHaveBeenCalled();
  });

  it("non-staff refused server-side before any read or write", async () => {
    const m = mockStore({}, false);
    await expect(approveCore(ap(), deps(m.store))).rejects.toThrow(/staff/);
    await expect(withdrawCore(wdIn(), deps(m.store))).rejects.toThrow(/staff/);
    expect(m.store.read).not.toHaveBeenCalled();
    expect(m.store.update).not.toHaveBeenCalled();
  });

  it.each([
    ["updated_at", { expectedUpdatedAt: "2026-11-06T10:40:48.123+00:00" }],
    ["outcome", { expectedOutcome: "rejected" }],
    ["stage", { expectedStage: "identified" }],
  ])("stale %s -> conflict, no write", async (_n, o) => {
    const m = mockStore();
    expect(await approveCore(ap(o), deps(m.store))).toMatchObject({ ok: false, code: "conflict" });
    expect(m.store.update).not.toHaveBeenCalled();
  });

  it("concurrent change between read and update -> conflict, single attempt, no retry", async () => {
    const m = mockStore();
    (m.store.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0);
    expect(await approveCore(ap(), deps(m.store))).toMatchObject({ code: "conflict" });
    expect(m.store.update).toHaveBeenCalledTimes(1);
  });

  it("reviewer identity and time come from the server, not the browser", async () => {
    const m = mockStore();
    const i = ap({ reviewed_by: "attacker", reviewed_at: "1999-01-01", source_id: "x", collection_job_id: "y" });
    expect(i).not.toHaveProperty("reviewed_by");
    expect(i).not.toHaveProperty("source_id");
    await approveCore(i, deps(m.store));
    expect(m.writes[0]).toMatchObject({ reviewed_by: "staff-user", reviewed_at: NOW.toISOString() });
  });

  it("opening the form never pre-confirms anything", () => {
    const p = initialProposal({
      confirmed_title: null, confirmed_identifier: null, confirmed_source_url: null,
      found_title: "T", found_identifier: "I", found_url: URL_,
    });
    expect(p).toEqual({ title: "T", identifier: "I", sourceUrl: URL_, confirm: { title: false, identifier: false, url: false } });
  });
});

describe("withdraw approval", () => {
  it("approved_for_collection -> source_located; writes only stage/reviewed_by/reviewed_at", async () => {
    const m = mockStore({ stage: "approved_for_collection" });
    expect(await withdrawCore(wdIn(), deps(m.store))).toEqual({ ok: true });
    expect(m.writes).toEqual([{ stage: "source_located", reviewed_by: "staff-user", reviewed_at: NOW.toISOString() }]);
  });

  it("requires explicit confirmation", () => {
    expect(() => wdIn({ confirmed: false })).toThrow(/confirmation/);
  });

  it("refuses when not approved", async () => {
    const m = mockStore({ stage: "lead" });
    expect(await withdrawCore(wdIn({ expectedStage: "lead" }), deps(m.store))).toMatchObject({ code: "invalid_transition" });
    expect(m.store.update).not.toHaveBeenCalled();
  });

  it("stale token -> conflict, no write", async () => {
    const m = mockStore({ stage: "approved_for_collection" });
    expect(await withdrawCore(wdIn({ expectedUpdatedAt: "old" }), deps(m.store))).toMatchObject({ code: "conflict" });
    expect(m.store.update).not.toHaveBeenCalled();
  });
});

describe("approval module isolation", () => {
  it("does not import sources, collection or LDH code and makes no external call", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./discovery-approval.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^import /m);
    expect(src).not.toMatch(/createSource|startCollectionJob|fetch\(|ldh/i);
  });
});

describe("withdraw while a source is linked", () => {
  it("refused at read time, no write", async () => {
    const m = mockStore({ stage: "approved_for_collection", source_id: "22222222-2222-4222-8222-222222222222" });
    expect(await withdrawCore(wdIn(), deps(m.store))).toMatchObject({ code: "invalid_transition" });
    expect(m.store.update).not.toHaveBeenCalled();
  });
  it("UPDATE guard includes source_id IS NULL; zero rows = conflict, single attempt", async () => {
    const m = mockStore({ stage: "approved_for_collection", source_id: null });
    (m.store.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0);
    expect(await withdrawCore(wdIn(), deps(m.store))).toMatchObject({ code: "conflict" });
    expect(m.store.update).toHaveBeenCalledTimes(1);
    expect((m.store.update as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({ sourceIdNull: true });
  });
});
