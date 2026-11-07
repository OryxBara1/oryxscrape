// "Approve for collection": a human decision only. Pure logic + injectable store (mock-testable).
// Approval does NOT create/link a source, create a job, start collection, change schedules or promote trust.
// Approve writes only: stage, confirmed_title, confirmed_identifier, confirmed_source_url, confidence, reviewed_by, reviewed_at.
// Withdraw writes only: stage, reviewed_by, reviewed_at.
// Stage order and preconditions are enforced here (app), not by the DB. No approval note, no stage history.
// reviewed_by/reviewed_at show only the LAST review action, set by the app server.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const APPROVABLE_FROM = ["lead", "identified", "source_located"] as const;

export type ApprovalState = {
  id: string; outcome: string; stage: string; needs_review: boolean; updated_at: string;
  confidence: Record<string, unknown> | null;
  /** Read for the withdraw rule (approval cannot be withdrawn while a source is linked). */
  source_id?: string | null;
};

/** sourceIdNull: also require source_id IS NULL in the UPDATE (withdraw). */
export type Guard = { outcome: string; stage: string; updated_at: string; sourceIdNull?: true };

export type ApprovePatch = {
  stage: "approved_for_collection";
  confirmed_title: string | null;
  confirmed_identifier: string | null;
  confirmed_source_url: string;
  confidence: Record<string, unknown>;
  reviewed_by: string;
  reviewed_at: string;
};
export type WithdrawPatch = { stage: "source_located"; reviewed_by: string; reviewed_at: string };

export type ApprovalStore = {
  isStaff(): Promise<boolean>;
  read(id: string): Promise<ApprovalState | null>;
  /** Guarded UPDATE; returns rows changed (0 = not applied). */
  update(id: string, guard: Guard, patch: ApprovePatch | WithdrawPatch): Promise<number>;
};

export type ApprovalResult =
  | { ok: true }
  | { ok: false; code: "conflict" | "not_found" | "invalid_transition" | "requirements"; message: string };

type Token = { id: string; expectedOutcome: string; expectedStage: string; expectedUpdatedAt: string };
export type ApproveInput = Token & {
  title: string | null; identifier: string | null; sourceUrl: string | null;
  confirm: { title: boolean; identifier: boolean; url: boolean };
};
export type WithdrawInput = Token & { confirmed: true };

function token(r: Record<string, unknown>): Token {
  const { id, expectedOutcome: eo, expectedStage: es, expectedUpdatedAt: eu } = r;
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Invalid candidate id.");
  if (typeof eo !== "string" || typeof es !== "string" || typeof eu !== "string" || !eu) throw new Error("Missing compare token.");
  return { id, expectedOutcome: eo, expectedStage: es, expectedUpdatedAt: eu };
}
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);

export function validateApproveInput(raw: unknown): ApproveInput {
  if (!raw || typeof raw !== "object") throw new Error("Invalid input.");
  const r = raw as Record<string, unknown>;
  const c = (r["confirm"] && typeof r["confirm"] === "object" ? r["confirm"] : {}) as Record<string, unknown>;
  // Only these fields survive; anything else (reviewed_by, source_id, …) is dropped.
  return {
    ...token(r),
    title: str(r["title"]), identifier: str(r["identifier"]), sourceUrl: str(r["sourceUrl"]),
    confirm: { title: c["title"] === true, identifier: c["identifier"] === true, url: c["url"] === true },
  };
}

export function validateWithdrawInput(raw: unknown): WithdrawInput {
  if (!raw || typeof raw !== "object") throw new Error("Invalid input.");
  const r = raw as Record<string, unknown>;
  if (r["confirmed"] !== true) throw new Error("Explicit confirmation required.");
  return { ...token(r), confirmed: true };
}

/** https only, exact string kept (no trimming/rewriting): rejects rather than fixes. */
export function isAcceptableSourceUrl(u: string): boolean {
  if (u.length > 4000 || u !== u.trim() || /\s/.test(u)) return false;
  try { return new URL(u).protocol === "https:"; } catch { return false; }
}

/** Returns a list of unmet requirements (empty = ok). */
export function approvalRequirements(cur: ApprovalState, i: ApproveInput): string[] {
  const miss: string[] = [];
  if (cur.outcome !== "open") miss.push("Outcome must be open.");
  if (cur.needs_review) miss.push("Clear the needs-review flag first.");
  if (!(APPROVABLE_FROM as readonly string[]).includes(cur.stage)) miss.push("Stage cannot be approved from here.");
  const titleOk = i.confirm.title && !!i.title && i.title.trim().length > 0 && i.title.length <= 500;
  const idOk = i.confirm.identifier && !!i.identifier && i.identifier.trim().length > 0 && i.identifier.length <= 300;
  if (!titleOk && !idOk) miss.push("Confirm a title or an identifier (identified stage).");
  if (!(i.confirm.url && i.sourceUrl && isAcceptableSourceUrl(i.sourceUrl))) miss.push("Confirm an https source URL (source located stage).");
  return miss;
}

export function buildApprovePatch(cur: ApprovalState, i: ApproveInput, userId: string, nowIso: string): ApprovePatch {
  const conf: Record<string, unknown> = { ...(cur.confidence ?? {}) };
  const t = i.confirm.title && i.title ? i.title : null;
  const d = i.confirm.identifier && i.identifier ? i.identifier : null;
  if (t) conf["title"] = "confirmed";
  if (d) conf["identifier"] = "confirmed";
  conf["url"] = "confirmed";
  return {
    stage: "approved_for_collection",
    confirmed_title: t, confirmed_identifier: d, confirmed_source_url: i.sourceUrl!,
    confidence: conf, reviewed_by: userId, reviewed_at: nowIso,
  };
}

const CONFLICT: ApprovalResult = {
  ok: false, code: "conflict",
  message: "This candidate changed since you opened it. Nothing was saved — reload and try again.",
};
type Deps<S> = { store: S; userId: string; now: () => Date };

async function load(store: ApprovalStore, t: Token): Promise<ApprovalState | ApprovalResult> {
  if (!(await store.isStaff())) throw new Error("Forbidden: staff only.");
  const cur = await store.read(t.id);
  if (!cur) return { ok: false, code: "not_found", message: "Candidate not found." };
  if (cur.outcome !== t.expectedOutcome || cur.stage !== t.expectedStage || cur.updated_at !== t.expectedUpdatedAt) return CONFLICT;
  return cur;
}
const guardOf = (t: Token): Guard => ({ outcome: t.expectedOutcome, stage: t.expectedStage, updated_at: t.expectedUpdatedAt });

export async function approveCore(i: ApproveInput, deps: Deps<ApprovalStore>): Promise<ApprovalResult> {
  const cur = await load(deps.store, i);
  if ("ok" in cur) return cur;
  const miss = approvalRequirements(cur, i);
  if (miss.length) return { ok: false, code: "requirements", message: miss.join(" ") };
  const n = await deps.store.update(i.id, guardOf(i), buildApprovePatch(cur, i, deps.userId, deps.now().toISOString()));
  return n === 1 ? { ok: true } : CONFLICT;
}

export async function withdrawCore(i: WithdrawInput, deps: Deps<ApprovalStore>): Promise<ApprovalResult> {
  const cur = await load(deps.store, i);
  if ("ok" in cur) return cur;
  if (cur.stage !== "approved_for_collection") return { ok: false, code: "invalid_transition", message: "Only an approved candidate can be withdrawn." };
  if (cur.source_id) return { ok: false, code: "invalid_transition", message: "Unlink the source before withdrawing approval." };
  const patch: WithdrawPatch = { stage: "source_located", reviewed_by: deps.userId, reviewed_at: deps.now().toISOString() };
  const n = await deps.store.update(i.id, { ...guardOf(i), sourceIdNull: true }, patch);
  return n === 1 ? { ok: true } : CONFLICT;
}

/** Initial form state: values are proposals; nothing is ever pre-confirmed. */
export function initialProposal(c: {
  confirmed_title: string | null; confirmed_identifier: string | null; confirmed_source_url: string | null;
  found_title: string | null; found_identifier: string | null; found_url: string | null;
}) {
  return {
    title: c.confirmed_title ?? c.found_title ?? "",
    identifier: c.confirmed_identifier ?? c.found_identifier ?? "",
    sourceUrl: c.confirmed_source_url ?? c.found_url ?? "",
    confirm: { title: false, identifier: false, url: false },
  };
}
