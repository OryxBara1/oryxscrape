import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listConsumerKeys = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("consumer_keys")
      .select(
        "id, consumer_app, key_prefix, is_active, note, last_used_at, revoked_at, created_at, profile_id, research_profiles(slug)",
      )
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  });

export const createConsumerKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { consumerApp: string; profileId: string; note?: string }) => {
    if (!input.consumerApp?.trim()) throw new Error("Consumer app name is required");
    if (!input.profileId) throw new Error("Research profile is required");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { mintConsumerKey } = await import("./consumer-keys.server");
    const { rawKey, keyPrefix, keyHash } = await mintConsumerKey();

    const { data: row, error } = await context.supabase
      .from("consumer_keys")
      .insert({
        consumer_app: data.consumerApp.trim(),
        profile_id: data.profileId,
        key_prefix: keyPrefix,
        key_hash: keyHash,
        note: data.note?.trim() || null,
      })
      .select("id, consumer_app, key_prefix, created_at")
      .single();
    if (error) throw new Error(error.message);

    // rawKey is returned exactly once and never stored in plaintext.
    return { key: row, rawKey };
  });

export const revokeConsumerKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("consumer_keys")
      .update({ is_active: false, revoked_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
