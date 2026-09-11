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
