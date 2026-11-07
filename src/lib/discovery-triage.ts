// Minimal human triage for discovery candidates. Pure logic + injectable store (mock-testable).
// Writes only: outcome, outcome_reason, needs_review, review_note, reviewed_by, reviewed_at.
// reviewed_by/reviewed_at are set by the app server (not protected by the DB guard trigger).
// needs_review/review_note keep only the current state — no history of their own.

export const TRIAGE_ACTIONS = ["reject", "out_of_scope", "reopen", "flag_review", "clear_review"] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

export type TriageInput = {
  id: string;
  action: TriageAction;
  text: string | null;
  expectedOutcome: string;
  expectedUpdatedAt: string;
};

export type CandidateState = { id: string; outcome: string; needs_review: boolean; updated_at: string };

export type TriagePatch = {
  outcome?: string;
  outcome_reason?: string;
  needs_review?: boolean;
  review_note?: string;
  reviewed_by: string;
  reviewed_at: string;
};

export type TriageStore = {
  isStaff(): Promise<boolean>;
  read(id: string): Promise<CandidateState | null>;
  /** Guarded UPDATE; returns number of rows changed (0 = not applied). */
  update(id: string, guard: { outcome: string; updated_at: string }, patch: TriagePatch): Promise<number>;
};

export type TriageResult =
  | { ok: true }
  | { ok: false; code: "conflict" | "not_found" | "invalid_transition"; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateTriageInput(raw: unknown): TriageInput {
  if (!raw || typeof raw !== "object") throw new Error("Invalid input.");
  const r = raw as Record<string, unknown>;
  const id = r["id"], action = r["action"], text = r["text"];
  const eo = r["expectedOutcome"], eu = r["expectedUpdatedAt"];
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Invalid candidate id.");
  if (typeof action !== "string" || !(TRIAGE_ACTIONS as readonly string[]).includes(action)) throw new Error("Invalid action.");
  if (typeof eo !== "string" || typeof eu !== "string" || !eu) throw new Error("Missing compare token.");
  const t = typeof text === "string" ? text.trim() : "";
  const a = action as TriageAction;
  if (a === "reject" || a === "out_of_scope" || a === "reopen") {
    if (t.length < 3 || t.length > 500) throw new Error("Reason must be 3–500 characters.");
  } else if (a === "flag_review") {
    if (t.length < 1 || t.length > 500) throw new Error("Note is required (max 500 characters).");
  }
  // Only these fields are kept; any other browser field (e.g. reviewed_by) is dropped.
  return { id, action: a, text: a === "clear_review" ? null : t, expectedOutcome: eo, expectedUpdatedAt: eu };
}

export function buildPatch(cur: CandidateState, input: TriageInput, userId: string, nowIso: string): TriagePatch | null {
  const who = { reviewed_by: userId, reviewed_at: nowIso };
  switch (input.action) {
    case "reject":
    case "out_of_scope":
      if (cur.outcome !== "open") return null;
      return { outcome: input.action === "reject" ? "rejected" : "out_of_scope", outcome_reason: input.text!, ...who };
    case "reopen":
      if (cur.outcome !== "rejected" && cur.outcome !== "out_of_scope") return null;
      return { outcome: "open", outcome_reason: input.text!, ...who };
    case "flag_review":
      return { needs_review: true, review_note: input.text!, ...who };
    case "clear_review":
      if (!cur.needs_review) return null;
      return { needs_review: false, ...who };
  }
}

const CONFLICT: TriageResult = {
  ok: false,
  code: "conflict",
  message: "This candidate changed since you opened it. Nothing was saved — reload and try again.",
};

export async function triageCore(
  input: TriageInput,
  deps: { store: TriageStore; userId: string; now: () => Date },
): Promise<TriageResult> {
  if (!(await deps.store.isStaff())) throw new Error("Forbidden: staff only.");
  const cur = await deps.store.read(input.id);
  if (!cur) return { ok: false, code: "not_found", message: "Candidate not found." };
  if (cur.outcome !== input.expectedOutcome || cur.updated_at !== input.expectedUpdatedAt) return CONFLICT;
  const patch = buildPatch(cur, input, deps.userId, deps.now().toISOString());
  if (!patch) return { ok: false, code: "invalid_transition", message: "This action is not allowed from the current state." };
  const n = await deps.store.update(input.id, { outcome: input.expectedOutcome, updated_at: input.expectedUpdatedAt }, patch);
  return n === 1 ? { ok: true } : CONFLICT;
}
