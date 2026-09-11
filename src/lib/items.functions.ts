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
      .from("staff_item_tier_matrix")
      .select("*")
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
