import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

type SourceInsert = Database["public"]["Tables"]["sources"]["Insert"];
type SourceUpdate = Database["public"]["Tables"]["sources"]["Update"];

export const listSources = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("sources")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  });

export const createSource = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: SourceInsert) => input)
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("sources")
      .insert(data)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const updateSource = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string; patch: SourceUpdate }) => input)
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("sources")
      .update(data.patch)
      .eq("id", data.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const deleteSource = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("sources").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
