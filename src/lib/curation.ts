// Client-safe curation model shared by the triage UI and server functions.
// Curation lives in normalized_items.payload.curation with a fixed shape (v1).

export const APPLICATION_STATUSES = [
  "directly_applicable",
  "requires_transposition",
  "implementation_to_verify",
  "not_applicable",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const APPLICATION_LABELS: Record<ApplicationStatus, string> = {
  directly_applicable: "Diretamente aplicável",
  requires_transposition: "Exige transposição",
  implementation_to_verify: "Implementação a verificar",
  not_applicable: "Não aplicável",
};

export const COVERED_JURISDICTIONS = ["ES", "FR", "IT", "HR", "PT", "GR", "MT", "CY", "NL", "DE"] as const;

export type Curation = {
  schema_version: 1;
  applies_to_jurisdictions: string[];
  application_status: ApplicationStatus | null;
  reviewer_note: string | null;
  reject_reason: string | null;
  curated_by: string | null;
  curated_at: string | null;
};

export function readCuration(payload: unknown): Curation | null {
  const p = payload as Record<string, unknown> | null;
  const c = p?.["curation"] as Partial<Curation> | undefined;
  if (!c || typeof c !== "object") return null;
  return {
    schema_version: 1,
    applies_to_jurisdictions: Array.isArray(c.applies_to_jurisdictions)
      ? c.applies_to_jurisdictions.filter((j): j is string => typeof j === "string")
      : [],
    application_status: APPLICATION_STATUSES.includes(c.application_status as ApplicationStatus)
      ? (c.application_status as ApplicationStatus)
      : null,
    reviewer_note: typeof c.reviewer_note === "string" ? c.reviewer_note : null,
    reject_reason: typeof c.reject_reason === "string" ? c.reject_reason : null,
    curated_by: typeof c.curated_by === "string" ? c.curated_by : null,
    curated_at: typeof c.curated_at === "string" ? c.curated_at : null,
  };
}

/** "Consistent" curation = at least one jurisdiction AND a valid application status. */
export function isCurationComplete(c: Curation | null): boolean {
  return !!c && c.applies_to_jurisdictions.length > 0 && c.application_status !== null;
}

export type DocType = "directive" | "regulation" | "decision" | "other";
export const DOC_TYPE_LABELS: Record<DocType, string> = {
  directive: "Diretiva",
  regulation: "Regulamento",
  decision: "Decisão",
  other: "Outro",
};

/** CELEX sector 3 acts: 3YYYYLnnnn (L directive, R regulation, D decision). */
export function docTypeFromCelex(celex: string | null | undefined): DocType {
  const m = /^\d{5}([A-Z])/.exec(celex ?? "");
  if (m?.[1] === "L") return "directive";
  if (m?.[1] === "R") return "regulation";
  if (m?.[1] === "D") return "decision";
  return "other";
}

export type TriageState =
  | "discovered"
  | "rejected"
  | "reviewed_partial"
  | "reviewed_scoped"
  | "approved"
  | "sent"
  | "archived";

export const TRIAGE_LABELS: Record<TriageState, string> = {
  discovered: "Descoberto",
  rejected: "Rejeitado",
  reviewed_partial: "Revisado (escopo incompleto)",
  reviewed_scoped: "Revisado (escopo definido)",
  approved: "Aprovado para Exchange",
  sent: "Enviado (01_Pending_Review)",
  archived: "Arquivado",
};

export function triageStateOf(input: {
  verification: string;
  publication: string;
  handoffState: string | null;
  curation: Curation | null;
}): TriageState {
  if (input.handoffState === "archived") return "archived";
  if (input.handoffState) return "sent";
  if (input.verification === "rejected") return "rejected";
  if (input.verification === "unreviewed") return "discovered";
  if (input.publication === "eligible") return "approved";
  return isCurationComplete(input.curation) ? "reviewed_scoped" : "reviewed_partial";
}
