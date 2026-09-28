import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const clean = (list?: string[]) =>
  Array.from(new Set((list ?? []).map((v) => v.trim()).filter(Boolean)));

export const listProfilesFull = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("research_profiles")
      .select(
        "id, slug, name, description, is_active, allowed_jurisdictions, allowed_tags, require_promotion, updated_at",
      )
      .order("slug");
    if (error) throw new Error(error.message);
    return data;
  });

type ProfileInput = {
  id?: string;
  slug: string;
  name: string;
  description?: string;
  is_active: boolean;
  allowed_jurisdictions: string[];
  allowed_tags: string[];
  require_promotion: boolean;
};

export const saveProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: ProfileInput) => {
    if (!/^[a-z0-9-]{3,60}$/.test(input.slug ?? "")) throw new Error("Slug: 3–60 letras minúsculas, números ou hífen");
    if (!input.name?.trim()) throw new Error("Nome é obrigatório");
    return input;
  })
  .handler(async ({ data, context }) => {
    const row = {
      slug: data.slug,
      name: data.name.trim(),
      description: data.description?.trim() || null,
      is_active: data.is_active,
      allowed_jurisdictions: clean(data.allowed_jurisdictions).map((j) => j.toUpperCase()),
      allowed_tags: clean(data.allowed_tags),
      require_promotion: data.require_promotion,
    };
    const q = data.id
      ? context.supabase.from("research_profiles").update(row).eq("id", data.id)
      : context.supabase.from("research_profiles").insert(row);
    const { error } = await q;
    if (error) throw new Error(error.message.includes("row-level") ? "Só o dono (owner) pode criar/editar perfis" : error.message);
    return { ok: true };
  });

export const setKeyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { keyId: string; profileId: string }) => input)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("consumer_keys")
      .update({ profile_id: data.profileId })
      .eq("id", data.keyId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listPromotionCandidates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { profileId: string; search?: string }) => input)
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("normalized_items")
      .select("id, source_url, jurisdiction_hint, payload, tags, reviewed_at")
      .eq("publication_status", "eligible")
      .order("reviewed_at", { ascending: false, nullsFirst: false })
      .limit(200);
    if (data.search?.trim()) q = q.ilike("source_url", `%${data.search.trim()}%`);
    const [{ data: items, error }, { data: exp, error: e2 }] = await Promise.all([
      q,
      context.supabase
        .from("normalized_item_profile_exposure")
        .select("normalized_item_id, promoted")
        .eq("profile_id", data.profileId),
    ]);
    if (error) throw new Error(error.message);
    if (e2) throw new Error(e2.message);
    const promoted = new Set((exp ?? []).filter((e) => e.promoted).map((e) => e.normalized_item_id));
    return (items ?? []).map((i) => {
      const p = (i.payload ?? {}) as Record<string, unknown>;
      return {
        id: i.id,
        source_url: i.source_url,
        jurisdiction: i.jurisdiction_hint,
        title: typeof p["title"] === "string" ? (p["title"] as string) : null,
        tags: i.tags ?? [],
        promoted: promoted.has(i.id),
      };
    });
  });

export const setPromotion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { profileId: string; itemId: string; promoted: boolean }) => input)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("normalized_item_profile_exposure").upsert(
      {
        profile_id: data.profileId,
        normalized_item_id: data.itemId,
        promoted: data.promoted,
        promoted_by: data.promoted ? context.userId : null,
        promoted_at: data.promoted ? new Date().toISOString() : null,
      },
      { onConflict: "normalized_item_id,profile_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });
