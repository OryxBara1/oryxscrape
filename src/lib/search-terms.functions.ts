import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

export type SearchTermLifecycle = Database["public"]["Enums"]["search_term_lifecycle"];

export const LIFECYCLE_STATES: SearchTermLifecycle[] = [
  "candidate",
  "promising",
  "validated",
  "ambiguous",
  "cooldown",
  "disabled_auto",
  "manual_only",
  "deprecated",
];

const SELECT =
  "id, concept_code, concept_label, country_code, language_code, term, target_domain, attempt_count, useful_count, false_positive_count, lifecycle_state, cooldown_until, last_run_at, notes, updated_at";

export const listSearchTerms = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("search_terms")
      .select(SELECT)
      .order("concept_code")
      .limit(500);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const setSearchTermLifecycle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string; lifecycleState: SearchTermLifecycle }) => {
    if (typeof input?.id !== "string" || !input.id) throw new Error("A term id is required.");
    if (!LIFECYCLE_STATES.includes(input.lifecycleState)) {
      throw new Error("Unknown lifecycle state.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: updated, error } = await context.supabase
      .from("search_terms")
      .update({ lifecycle_state: data.lifecycleState })
      .eq("id", data.id)
      .select("id, lifecycle_state")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) throw new Error("Term not found.");
    return updated;
  });

export const exportSearchTerms = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const drive = await import("./drive.server");
    const { EXCHANGE_FOLDERS } = await import("./exchange-config");

    const { data, error } = await context.supabase
      .from("search_terms")
      .select(
        "concept_code, concept_label, country_code, language_code, term, target_domain, attempt_count, useful_count, false_positive_count, lifecycle_state",
      )
      .order("concept_code");
    if (error) throw new Error(error.message);
    const rows = data ?? [];

    const headers = [
      "concept_code",
      "concept_label",
      "country_code",
      "language_code",
      "term",
      "target_domain",
      "attempt_count",
      "useful_count",
      "false_positive_count",
      "lifecycle_state",
    ];
    const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const csv = [
      headers.join(","),
      ...rows.map((r) => headers.map((h) => escape((r as Record<string, unknown>)[h])).join(",")),
    ].join("\n");

    const stamp = new Date().toISOString().slice(0, 10);
    const csvFile = await drive.uploadTextFile({
      name: `search_terms_${stamp}.csv`,
      parentId: EXCHANGE_FOLDERS.searchTermsShared,
      mimeType: "text/csv",
      content: csv,
    });
    const jsonFile = await drive.uploadTextFile({
      name: `search_terms_${stamp}.json`,
      parentId: EXCHANGE_FOLDERS.searchTermsShared,
      mimeType: "application/json",
      content: JSON.stringify({ exported_at: new Date().toISOString(), terms: rows }, null, 2),
    });

    return { count: rows.length, csvFileId: csvFile.id, jsonFileId: jsonFile.id };
  });
