// Slice (a): link / create / unlink a source on an approved discovery candidate. NO collection.
// None of these actions creates a job, collects, changes retrieval_state, sets collection_job_id/raw_item_id,
// changes stage, or edits/deletes an existing source. Rules are app-enforced (not DB).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SourceRow = {
  id: string; name: string; domain: string; start_url: string; collection_method: string;
  is_active: boolean; schedule_enabled: boolean;
  is_official_domain: boolean; is_primary_document: boolean;
  traceability_level: string; institution_class: string; tos_status: string; robots_status: string;
};

/**
 * Mirrors EXACTLY the branch order of startCollectionJob today (not a collector refactor):
 * start_url.includes("transport.gov.mt") -> Malta chain; "api" -> per-country collector;
 * "http" -> runPdfCollection; anything else -> Apify crawl.
 */
export type CollectionRoute = "malta" | "api" | "http" | "apify";
export function collectionRouteOf(s: Pick<SourceRow, "start_url" | "collection_method">): CollectionRoute {
  if (s.start_url.includes("transport.gov.mt")) return "malta";
  if (s.collection_method === "api") return "api";
  if (s.collection_method === "http") return "http";
  return "apify";
}

/** Single rule used by BOTH listing and linking. */
export function isCompatibleSource(s: SourceRow): boolean {
  return collectionRouteOf(s) === "http" && s.is_active === true && s.schedule_enabled === false;
}

export type LinkCandidate = {
  id: string; stage: string; outcome: string; needs_review: boolean; updated_at: string;
  source_id: string | null; collection_job_id: string | null; raw_item_id: string | null;
  retrieval_state: string; confirmed_source_url: string | null;
};

export type CandidateGuard = {
  updated_at: string; stage: string; outcome: string; needs_review: boolean;
  source_id: string | null; // expected (null = IS NULL)
  noJobNoRawNone?: true; // unlink: collection_job_id IS NULL, raw_item_id IS NULL, retrieval_state = 'none'
};
export type SourceLinkPatch = { source_id: string | null; reviewed_by: string; reviewed_at: string };

export const TOS = ["unknown", "allowed", "restricted", "prohibited"] as const;
export const ROBOTS = ["unknown", "allowed", "disallowed", "partial"] as const;
export const TRACEABILITY = ["direct_url", "domain_indicated", "third_party_hosted", "untraceable"] as const;
export const INSTITUTION = ["government", "intergovernmental", "court", "academic", "professional_body", "registered_media", "commercial", "unknown"] as const;
/** DB defaults, shown as hints only — never applied as fallback. */
export const SOURCE_DB_DEFAULTS = {
  is_official_domain: false, is_primary_document: false, traceability_level: "untraceable",
  institution_class: "unknown", tos_status: "unknown", robots_status: "unknown",
} as const;

export type NewSourcePayload = {
  name: string; domain: string; start_url: string; collection_method: "http";
  is_active: true; schedule_enabled: false;
  is_official_domain: boolean; is_primary_document: boolean;
  traceability_level: string; institution_class: string; tos_status: string; robots_status: string;
  notes?: string;
};

export type LinkStore = {
  isStaff(): Promise<boolean>;
  readCandidate(id: string): Promise<LinkCandidate | null>;
  readSource(id: string): Promise<SourceRow | null>;
  listSources(): Promise<SourceRow[]>;
  findSource(domain: string, startUrl: string): Promise<SourceRow | null>;
  /** Returns the new id, or "duplicate" on UNIQUE(domain,start_url). */
  insertSource(p: NewSourcePayload): Promise<{ id: string } | "duplicate">;
  updateCandidate(id: string, guard: CandidateGuard, patch: SourceLinkPatch): Promise<number>;
};

export type LinkResult =
  | { ok: true; sourceId?: string }
  | {
      ok: false;
      code: "conflict" | "not_found" | "not_eligible" | "incompatible" | "url_mismatch" | "exists";
      message: string;
      createdSourceId?: string;
      existingSource?: SourceRow;
    };

type Token = { id: string; expectedUpdatedAt: string };
export type LinkInput = Token & { sourceId: string; candidateUrl: string; sourceUrl: string; confirmUrlMismatch: boolean };
export type UnlinkInput = Token & { sourceId: string };
export type CreateInput = Token & {
  candidateUrl: string; name: string; notes: string | null;
  is_official_domain: boolean; is_primary_document: boolean;
  traceability_level: string; institution_class: string; tos_status: string; robots_status: string;
};

function obj(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") throw new Error("Invalid input.");
  return raw as Record<string, unknown>;
}
function token(r: Record<string, unknown>): Token {
  const id = r["id"], eu = r["expectedUpdatedAt"];
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Invalid candidate id.");
  if (typeof eu !== "string" || !eu) throw new Error("Missing compare token.");
  return { id, expectedUpdatedAt: eu };
}
function uuid(v: unknown, what: string): string {
  if (typeof v !== "string" || !UUID.test(v)) throw new Error(`Invalid ${what}.`);
  return v;
}
function str(v: unknown, what: string): string {
  if (typeof v !== "string" || !v) throw new Error(`Missing ${what}.`);
  return v;
}
function oneOf(v: unknown, list: readonly string[], what: string): string {
  if (typeof v !== "string" || !list.includes(v)) throw new Error(`Choose ${what}.`);
  return v;
}
function bool(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") throw new Error(`Choose ${what}.`);
  return v;
}

export function validateLinkInput(raw: unknown): LinkInput {
  const r = obj(raw);
  return {
    ...token(r), sourceId: uuid(r["sourceId"], "source id"),
    candidateUrl: str(r["candidateUrl"], "candidate URL"), sourceUrl: str(r["sourceUrl"], "source URL"),
    confirmUrlMismatch: r["confirmUrlMismatch"] === true,
  };
}
export function validateUnlinkInput(raw: unknown): UnlinkInput {
  const r = obj(raw);
  return { ...token(r), sourceId: uuid(r["sourceId"], "source id") };
}
export function validateCreateInput(raw: unknown): CreateInput {
  const r = obj(raw);
  const name = typeof r["name"] === "string" ? r["name"].trim() : "";
  if (name.length < 3 || name.length > 200) throw new Error("Name must be 3–200 characters.");
  const notes = typeof r["notes"] === "string" && r["notes"].trim() ? r["notes"].trim().slice(0, 500) : null;
  // Every classification field must be chosen explicitly — no fallback to DB defaults.
  return {
    ...token(r), candidateUrl: str(r["candidateUrl"], "candidate URL"), name, notes,
    is_official_domain: bool(r["is_official_domain"], "official domain"),
    is_primary_document: bool(r["is_primary_document"], "primary document"),
    traceability_level: oneOf(r["traceability_level"], TRACEABILITY, "traceability"),
    institution_class: oneOf(r["institution_class"], INSTITUTION, "institution class"),
    tos_status: oneOf(r["tos_status"], TOS, "terms status"),
    robots_status: oneOf(r["robots_status"], ROBOTS, "robots status"),
  };
}

export function eligibilityProblem(c: LinkCandidate, expectedUpdatedAt: string): LinkResult | null {
  if (c.updated_at !== expectedUpdatedAt) return CONFLICT;
  if (c.stage !== "approved_for_collection" || c.outcome !== "open" || c.needs_review || c.source_id !== null) {
    return { ok: false, code: "not_eligible", message: "Candidate must be approved, open, not flagged and without a source." };
  }
  return null;
}

const CONFLICT: LinkResult = {
  ok: false, code: "conflict",
  message: "This candidate changed since you opened it. Nothing was saved — reload and try again.",
};
type Deps = { store: LinkStore; userId: string; now: () => Date };

const linkGuard = (c: LinkCandidate, expectedUpdatedAt: string): CandidateGuard => ({
  updated_at: expectedUpdatedAt, stage: "approved_for_collection", outcome: "open", needs_review: false, source_id: null,
});
const who = (d: Deps) => ({ reviewed_by: d.userId, reviewed_at: d.now().toISOString() });

async function staff(d: Deps) {
  if (!(await d.store.isStaff())) throw new Error("Forbidden: staff only.");
}

export async function listCompatibleCore(d: Deps): Promise<SourceRow[]> {
  await staff(d);
  return (await d.store.listSources()).filter(isCompatibleSource);
}

export async function linkCore(i: LinkInput, d: Deps): Promise<LinkResult> {
  await staff(d);
  const c = await d.store.readCandidate(i.id);
  if (!c) return { ok: false, code: "not_found", message: "Candidate not found." };
  const bad = eligibilityProblem(c, i.expectedUpdatedAt);
  if (bad) return bad;
  const s = await d.store.readSource(i.sourceId);
  if (!s) return { ok: false, code: "not_found", message: "Source not found." };
  if (!isCompatibleSource(s)) return { ok: false, code: "incompatible", message: "Source must be http, active, not scheduled and not routed to another collector." };
  // Both URLs shown to the user must still match the current rows exactly.
  if (i.candidateUrl !== c.confirmed_source_url || i.sourceUrl !== s.start_url) return CONFLICT;
  if (i.sourceUrl !== i.candidateUrl && !i.confirmUrlMismatch) {
    return { ok: false, code: "url_mismatch", message: "The source start URL differs from the candidate URL. Confirm explicitly to link." };
  }
  const n = await d.store.updateCandidate(i.id, linkGuard(c, i.expectedUpdatedAt), { source_id: s.id, ...who(d) });
  return n === 1 ? { ok: true, sourceId: s.id } : CONFLICT;
}

export async function unlinkCore(i: UnlinkInput, d: Deps): Promise<LinkResult> {
  await staff(d);
  const c = await d.store.readCandidate(i.id);
  if (!c) return { ok: false, code: "not_found", message: "Candidate not found." };
  if (c.updated_at !== i.expectedUpdatedAt || c.source_id !== i.sourceId) return CONFLICT;
  if (c.collection_job_id || c.raw_item_id || c.retrieval_state !== "none") {
    return { ok: false, code: "not_eligible", message: "A collection is already associated; the source cannot be unlinked." };
  }
  const n = await d.store.updateCandidate(
    i.id,
    { updated_at: i.expectedUpdatedAt, stage: c.stage, outcome: c.outcome, needs_review: c.needs_review, source_id: i.sourceId, noJobNoRawNone: true },
    { source_id: null, ...who(d) },
  );
  return n === 1 ? { ok: true } : CONFLICT;
}

export function buildNewSource(i: CreateInput, url: string): NewSourcePayload {
  const p: NewSourcePayload = {
    name: i.name, domain: new URL(url).hostname, start_url: url,
    collection_method: "http", is_active: true, schedule_enabled: false,
    is_official_domain: i.is_official_domain, is_primary_document: i.is_primary_document,
    traceability_level: i.traceability_level, institution_class: i.institution_class,
    tos_status: i.tos_status, robots_status: i.robots_status,
  };
  if (i.notes) p.notes = i.notes;
  return p;
}

export async function createAndLinkCore(i: CreateInput, d: Deps): Promise<LinkResult> {
  await staff(d);
  // 1) eligibility + token BEFORE inserting anything
  const c = await d.store.readCandidate(i.id);
  if (!c) return { ok: false, code: "not_found", message: "Candidate not found." };
  const bad = eligibilityProblem(c, i.expectedUpdatedAt);
  if (bad) return bad;
  const url = c.confirmed_source_url;
  if (!url || i.candidateUrl !== url) return CONFLICT;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, code: "not_eligible", message: "Confirmed source URL is not valid." }; }
  if (parsed.protocol !== "https:") return { ok: false, code: "not_eligible", message: "Confirmed source URL must be https." };
  const payload = buildNewSource(i, url);
  if (collectionRouteOf(payload) !== "http") {
    return { ok: false, code: "incompatible", message: "This URL is routed to another collector; an http source cannot be created for it here." };
  }
  // 2) insert (UNIQUE(domain,start_url) -> show existing, never duplicate)
  const ins = await d.store.insertSource(payload);
  if (ins === "duplicate") {
    const existing = await d.store.findSource(payload.domain, payload.start_url);
    return {
      ok: false, code: "exists",
      message: existing && isCompatibleSource(existing)
        ? "A source with this URL already exists. Review it and link it instead."
        : "A source with this URL already exists but is not compatible; it was not changed.",
      ...(existing ? { existingSource: existing } : {}),
    };
  }
  // 3) re-validate and link; on refusal report the created source for recovery
  const c2 = await d.store.readCandidate(i.id);
  const recover = (r: LinkResult): LinkResult => (r.ok ? r : { ...r, createdSourceId: ins.id, message: `Source created but not linked. ${r.message}` });
  if (!c2) return recover({ ok: false, code: "not_found", message: "Candidate not found." });
  const bad2 = eligibilityProblem(c2, i.expectedUpdatedAt);
  if (bad2) return recover(bad2);
  const n = await d.store.updateCandidate(i.id, linkGuard(c2, i.expectedUpdatedAt), { source_id: ins.id, ...who(d) });
  return n === 1 ? { ok: true, sourceId: ins.id } : recover(CONFLICT);
}
