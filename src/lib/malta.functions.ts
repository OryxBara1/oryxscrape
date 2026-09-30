/**
 * Malta collector — staff-only triggers. Manual start only (no scheduling).
 */

import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

async function assertStaff(supabase: SupabaseClient<Database>) {
  const { data, error } = await supabase.rpc("is_staff");
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Staff access required.");
}

export const startMaltaCollection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        profileId: z.string().uuid().nullable().optional(),
        urls: z.array(z.string().url()).max(25).optional(),
        maxDocuments: z.number().int().min(1).max(25).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertStaff(context.supabase);
    const { runMaltaCollection } = await import("./malta-collect.server");
    return runMaltaCollection({ supabase: context.supabase, ...data });
  });

export const runMaltaRetroactivePass = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ limit: z.number().int().min(1).max(15).optional() }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    await assertStaff(context.supabase);
    const { runMaltaRetroactivePass: run } = await import("./malta-collect.server");
    return run({ supabase: context.supabase, limit: data.limit });
  });
