import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

type TierLabel = Database["public"]["Enums"]["tier_label"];

export const listResearchProfiles = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("research_profiles")
      .select("id, slug, name, is_active")
      .order("slug");
    if (error) throw new Error(error.message);
    return data;
  });

export const listTierMatrix = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      profileId?: string | null;
      tier?: TierLabel | null;
      jurisdiction?: string | null;
      category?: string | null;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .rpc("get_staff_item_tier_matrix")
      .order("updated_at", { ascending: false })
      .limit(200);

    if (data.profileId) query = query.eq("profile_id", data.profileId);
    if (data.tier) query = query.eq("resolved_tier", data.tier);
    if (data.jurisdiction) query = query.ilike("jurisdiction_hint", `%${data.jurisdiction}%`);
    if (data.category) query = query.ilike("category", `%${data.category}%`);

    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    return rows;
  });

export const getItemDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { normalizedItemId: string }) => {
    if (typeof input?.normalizedItemId !== "string" || !input.normalizedItemId) {
      throw new Error("A normalized item id is required.");
    }
    return { normalizedItemId: input.normalizedItemId };
  })
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("normalized_items")
      .select(
        `
        id,
        source_url,
        jurisdiction_hint,
        category,
        payload,
        is_official_domain,
        is_primary_document,
        traceability_level,
        institution_class,
        verification_status,
        publication_status,
        updated_at,
        raw_items (
          raw_payload,
          canonical_url,
          language,
          content_type,
          http_status,
          collector_version
        )
      `,
      )
      .eq("id", data.normalizedItemId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!row) throw new Error("Item not found.");

    const raw = Array.isArray(row.raw_items) ? row.raw_items[0] : row.raw_items;
    const rawPayload = (raw?.raw_payload as Record<string, unknown> | null) ?? {};
    const normalizedPayload = (row.payload as Record<string, unknown> | null) ?? {};

    const title =
      typeof normalizedPayload["title"] === "string" && normalizedPayload["title"]
        ? normalizedPayload["title"]
        : typeof rawPayload["title"] === "string" && rawPayload["title"]
          ? rawPayload["title"]
          : null;

    const extractedText =
      typeof rawPayload["text"] === "string" && rawPayload["text"]
        ? rawPayload["text"]
        : typeof normalizedPayload["body_excerpt"] === "string" && normalizedPayload["body_excerpt"]
          ? normalizedPayload["body_excerpt"]
          : typeof normalizedPayload["text"] === "string" && normalizedPayload["text"]
            ? normalizedPayload["text"]
            : null;

    return {
      id: row.id,
      title,
      sourceUrl: row.source_url,
      canonicalUrl: raw?.canonical_url ?? null,
      jurisdictionHint: row.jurisdiction_hint,
      category: row.category,
      language: raw?.language ?? null,
      contentType: raw?.content_type ?? null,
      httpStatus: raw?.http_status ?? null,
      collectorVersion: raw?.collector_version ?? null,
      isOfficialDomain: row.is_official_domain,
      isPrimaryDocument: row.is_primary_document,
      traceabilityLevel: row.traceability_level,
      institutionClass: row.institution_class,
      verificationStatus: row.verification_status,
      publicationStatus: row.publication_status,
      updatedAt: row.updated_at,
      extractedText,
    };
  });

export const setItemPromotion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { normalizedItemId: string; profileId: string; promoted: boolean }) => input,
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: existing, error: readError } = await supabase
      .from("normalized_item_profile_exposure")
      .select("id")
      .eq("normalized_item_id", data.normalizedItemId)
      .eq("profile_id", data.profileId)
      .maybeSingle();
    if (readError) throw new Error(readError.message);

    const patch = {
      promoted: data.promoted,
      promoted_by: data.promoted ? userId : null,
      promoted_at: data.promoted ? new Date().toISOString() : null,
    };

    if (existing) {
      const { error } = await supabase
        .from("normalized_item_profile_exposure")
        .update(patch)
        .eq("id", existing.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabase.from("normalized_item_profile_exposure").insert({
        normalized_item_id: data.normalizedItemId,
        profile_id: data.profileId,
        ...patch,
      });
      if (error) throw new Error(error.message);
    }

    return { ok: true, promoted: data.promoted };
  });

type VerificationStatus = Database["public"]["Enums"]["verification_status"];
type PublicationStatus = Database["public"]["Enums"]["publication_status"];

export type ReviewAction =
  | "review"
  | "reject"
  | "reopen"
  | "mark_eligible"
  | "set_internal_only";

const TRANSITIONS: Record<
  ReviewAction,
  {
    from: Array<{ verification: VerificationStatus; publication: PublicationStatus }>;
    to: { verification: VerificationStatus; publication: PublicationStatus };
  }
> = {
  review: {
    from: [{ verification: "unreviewed", publication: "internal_only" }],
    to: { verification: "reviewed", publication: "internal_only" },
  },
  reject: {
    from: [
      { verification: "unreviewed", publication: "internal_only" },
      { verification: "reviewed", publication: "internal_only" },
    ],
    to: { verification: "rejected", publication: "internal_only" },
  },
  reopen: {
    from: [{ verification: "rejected", publication: "internal_only" }],
    to: { verification: "unreviewed", publication: "internal_only" },
  },
  mark_eligible: {
    from: [{ verification: "reviewed", publication: "internal_only" }],
    to: { verification: "reviewed", publication: "eligible" },
  },
  set_internal_only: {
    from: [{ verification: "reviewed", publication: "eligible" }],
    to: { verification: "reviewed", publication: "internal_only" },
  },
};

export function allowedActionsFor(
  verification: VerificationStatus,
  publication: PublicationStatus,
): ReviewAction[] {
  return (Object.keys(TRANSITIONS) as ReviewAction[]).filter((action) =>
    TRANSITIONS[action].from.some(
      (s) => s.verification === verification && s.publication === publication,
    ),
  );
}

export const setItemReviewState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { normalizedItemId: string; action: ReviewAction }) => {
    if (typeof input?.normalizedItemId !== "string" || !input.normalizedItemId) {
      throw new Error("A normalized item id is required.");
    }
    if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, input.action)) {
      throw new Error("Unknown review action.");
    }
    return { normalizedItemId: input.normalizedItemId, action: input.action };
  })
  .handler(async ({ data, context }) => {
    // actor identity comes from the verified session, never from the request body
    const { supabase, userId } = context;

    const { data: current, error: readError } = await supabase
      .from("normalized_items")
      .select("id, verification_status, publication_status")
      .eq("id", data.normalizedItemId)
      .maybeSingle();
    if (readError) throw new Error(readError.message);
    if (!current) throw new Error("Item not found.");

    const rule = TRANSITIONS[data.action];
    const allowed = rule.from.some(
      (s) =>
        s.verification === current.verification_status &&
        s.publication === current.publication_status,
    );
    if (!allowed) {
      throw new Error(
        `This action is not allowed from ${current.verification_status}/${current.publication_status}.`,
      );
    }

    const patch: {
      verification_status: VerificationStatus;
      publication_status: PublicationStatus;
      reviewed_by: string | null;
      reviewed_at: string | null;
    } = {
      verification_status: rule.to.verification,
      publication_status: rule.to.publication,
      reviewed_by: rule.to.verification === "unreviewed" ? null : userId,
      reviewed_at: rule.to.verification === "unreviewed" ? null : new Date().toISOString(),
    };

    const { data: updated, error } = await supabase
      .from("normalized_items")
      .update(patch)
      .eq("id", data.normalizedItemId)
      .eq("verification_status", current.verification_status)
      .eq("publication_status", current.publication_status)
      .select("id, verification_status, publication_status, updated_at")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) throw new Error("The item changed before this action could be applied.");

    return {
      id: updated.id,
      verificationStatus: updated.verification_status,
      publicationStatus: updated.publication_status,
      updatedAt: updated.updated_at,
    };
  });

// ---------------------------------------------------------------------------
// Triage (curation) — payload.curation, audited per change.
// ---------------------------------------------------------------------------

import {
  APPLICATION_STATUSES,
  COVERED_JURISDICTIONS,
  docTypeFromCelex,
  isCurationComplete,
  readCuration,
  triageStateOf,
  type ApplicationStatus,
  type Curation,
} from "@/lib/curation";

export type TriageFilters = {
  jurisdiction?: string | null;
  state?: string | null;
  domain?: string | null;
  docType?: string | null;
  application?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  q?: string | null;
};

type TriageRowDb = {
  id: string;
  source_url: string;
  jurisdiction_hint: string | null;
  category: string | null;
  payload: Record<string, unknown> | null;
  tags: string[] | null;
  verification_status: VerificationStatus;
  publication_status: PublicationStatus;
  collected_at: string;
  updated_at: string;
  sources: { domain: string } | null;
};

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export const listTriageItems = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: TriageFilters) => input ?? {})
  .handler(async ({ data, context }) => {
    const sel = (s: string): string => s;
    let query = context.supabase
      .from("normalized_items")
      .select(
        sel(
          "id, source_url, jurisdiction_hint, category, payload, tags, verification_status, publication_status, collected_at, updated_at, sources(domain)",
        ),
      )
      .order("collected_at", { ascending: false })
      .limit(1000);
    if (data.jurisdiction) query = query.eq("jurisdiction_hint", data.jurisdiction);
    const { data: rows, error } = await query.returns<TriageRowDb[]>();
    if (error) throw new Error(error.message);

    const ids = rows.map((r) => r.id);
    const handoffs = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data: hs, error: hErr } = await context.supabase
        .from("exchange_handoffs")
        .select("normalized_item_id, state, created_at")
        .in("normalized_item_id", ids.slice(i, i + 200))
        .order("created_at", { ascending: true });
      if (hErr) throw new Error(hErr.message);
      for (const h of hs ?? []) handoffs.set(h.normalized_item_id, h.state);
    }

    const q = (data.q ?? "").trim().toLowerCase();
    const mapped = rows.map((r) => {
      const p = r.payload ?? {};
      const celex = str(p["celexNumber"]);
      const curation = readCuration(p);
      return {
        id: r.id,
        title: str(p["title"]),
        celex,
        docType: celex ? docTypeFromCelex(celex) : null,
        date: str(p["published_at"]) ?? str(p["publication_date"]),
        sourceUrl: r.source_url,
        domain: r.sources?.domain ?? null,
        jurisdictionHint: r.jurisdiction_hint,
        tags: r.tags ?? [],
        verificationStatus: r.verification_status,
        publicationStatus: r.publication_status,
        curation,
        state: triageStateOf({
          verification: r.verification_status,
          publication: r.publication_status,
          handoffState: handoffs.get(r.id) ?? null,
          curation,
        }),
        collectedAt: r.collected_at,
      };
    });

    const filtered = mapped.filter((m) => {
      if (data.state && m.state !== data.state) return false;
      if (data.domain && m.domain !== data.domain) return false;
      if (data.docType && m.docType !== data.docType) return false;
      if (data.application && m.curation?.application_status !== data.application) return false;
      const d = m.date ?? m.collectedAt.slice(0, 10);
      if (data.dateFrom && d < data.dateFrom) return false;
      if (data.dateTo && d > data.dateTo) return false;
      return true;
    });

    if (!q) return filtered.slice(0, 300);
    // CELEX exact match wins over any title/tag match.
    const exact = filtered.filter((m) => m.celex?.toLowerCase() === q);
    if (exact.length) return exact;
    return filtered
      .filter(
        (m) =>
          m.celex?.toLowerCase().includes(q) ||
          m.title?.toLowerCase().includes(q) ||
          m.tags.some((t) => t.toLowerCase().includes(q)),
      )
      .slice(0, 300);
  });

async function writeCurationAudit(
  supabase: import("@supabase/supabase-js").SupabaseClient<Database>,
  itemId: string,
  userId: string,
  action: string,
  previous: Curation | null,
  next: Curation | null,
) {
  const { error } = await supabase.from("audit_events").insert({
    check_type: "review_status_change",
    target_table: "normalized_items",
    target_id: itemId,
    result: "ok",
    findings: {
      kind: "curation",
      action,
      normalized_item_id: itemId,
      actor_user_id: userId,
      previous,
      next,
      changed_at: new Date().toISOString(),
    } as never,
  });
  if (error) throw new Error(`Audit write failed: ${error.message}`);
}

export const saveItemCuration = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      normalizedItemId: string;
      appliesTo: string[];
      applicationStatus: ApplicationStatus | null;
      reviewerNote: string | null;
      approve?: boolean;
    }) => {
      if (!input?.normalizedItemId) throw new Error("A normalized item id is required.");
      const appliesTo = Array.from(new Set(input.appliesTo ?? [])).filter((j) =>
        (COVERED_JURISDICTIONS as readonly string[]).includes(j),
      );
      if (input.applicationStatus && !APPLICATION_STATUSES.includes(input.applicationStatus)) {
        throw new Error("Invalid application status.");
      }
      return {
        normalizedItemId: input.normalizedItemId,
        appliesTo,
        applicationStatus: input.applicationStatus ?? null,
        reviewerNote: (input.reviewerNote ?? "").trim().slice(0, 2000) || null,
        approve: !!input.approve,
      };
    },
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: current, error } = await supabase
      .from("normalized_items")
      .select("id, payload, verification_status, publication_status, updated_at")
      .eq("id", data.normalizedItemId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!current) throw new Error("Item not found.");
    if (current.verification_status === "rejected") {
      throw new Error("Rejected items must be reopened before curation.");
    }
    if (current.publication_status === "eligible" && !data.approve) {
      throw new Error("Item already approved; set it back to internal only to change scope.");
    }

    const previous = readCuration(current.payload);
    const next: Curation = {
      schema_version: 1,
      applies_to_jurisdictions: data.appliesTo,
      application_status: data.applicationStatus,
      reviewer_note: data.reviewerNote,
      reject_reason: null,
      curated_by: userId,
      curated_at: new Date().toISOString(),
    };
    if (data.approve && !isCurationComplete(next)) {
      throw new Error("Approval requires at least one jurisdiction and an application status.");
    }

    const payload = { ...((current.payload as Record<string, unknown>) ?? {}), curation: next };
    const patch: Database["public"]["Tables"]["normalized_items"]["Update"] = {
      payload: payload as never,
      verification_status: "reviewed",
      publication_status: data.approve ? "eligible" : current.publication_status,
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
    };
    const { data: updated, error: upErr } = await supabase
      .from("normalized_items")
      .update(patch)
      .eq("id", data.normalizedItemId)
      .eq("updated_at", current.updated_at)
      .select("id")
      .maybeSingle();
    if (upErr) throw new Error(upErr.message);
    if (!updated) throw new Error("The item changed before this action could be applied.");

    await writeCurationAudit(
      supabase,
      data.normalizedItemId,
      userId,
      data.approve ? "approve_for_exchange" : "save_scope",
      previous,
      next,
    );
    return { ok: true, approved: data.approve };
  });

export const rejectItems = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { normalizedItemIds: string[]; reason: string }) => {
    const ids = Array.from(new Set(input?.normalizedItemIds ?? [])).filter(
      (id) => typeof id === "string" && id,
    );
    if (!ids.length) throw new Error("Select at least one item.");
    if (ids.length > 200) throw new Error("At most 200 items per batch.");
    const reason = (input.reason ?? "").trim().slice(0, 500);
    if (!reason) throw new Error("A rejection reason is required.");
    return { ids, reason };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of data.ids) {
      try {
        const { data: current, error } = await supabase
          .from("normalized_items")
          .select("id, payload, verification_status, publication_status")
          .eq("id", id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!current) throw new Error("Item not found.");
        if (current.publication_status !== "internal_only" || current.verification_status === "rejected") {
          throw new Error(`Not rejectable from ${current.verification_status}/${current.publication_status}.`);
        }
        const previous = readCuration(current.payload);
        const next: Curation = {
          ...(previous ?? {
            schema_version: 1,
            applies_to_jurisdictions: [],
            application_status: null,
            reviewer_note: null,
          }),
          schema_version: 1,
          reject_reason: data.reason,
          curated_by: userId,
          curated_at: new Date().toISOString(),
        } as Curation;
        const payload = { ...((current.payload as Record<string, unknown>) ?? {}), curation: next };
        const { data: updated, error: upErr } = await supabase
          .from("normalized_items")
          .update({
            payload: payload as never,
            verification_status: "rejected",
            publication_status: "internal_only",
            reviewed_by: userId,
            reviewed_at: new Date().toISOString(),
          })
          .eq("id", id)
          .eq("verification_status", current.verification_status)
          .select("id")
          .maybeSingle();
        if (upErr) throw new Error(upErr.message);
        if (!updated) throw new Error("Item changed concurrently.");
        await writeCurationAudit(supabase, id, userId, "reject", previous, next);
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: e instanceof Error ? e.message : "Unknown error" });
      }
    }
    return {
      rejected: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok),
    };
  });
