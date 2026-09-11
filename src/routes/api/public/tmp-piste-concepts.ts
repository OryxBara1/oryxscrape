import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/tmp-piste-concepts")({
  server: {
    handlers: {
      GET: async () => {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { runPisteCollection } = await import("@/lib/piste-collect.server");
        const { normalizeWithLogoriOn } = await import("@/lib/logorion.server");

        const { data: source, error } = await supabaseAdmin
          .from("sources")
          .select(
            "id, is_official_domain, is_primary_document, traceability_level, institution_class",
          )
          .eq("domain", "piste.gouv.fr")
          .single();
        if (error) return Response.json({ step: "source", error: error.message }, { status: 500 });

        const run = await runPisteCollection({
          supabase: supabaseAdmin,
          source,
          profileId: null,
          maxItems: 2,
          concepts: [
            {
              concept_label: "recreational_nautical_license",
              query: '"permis plaisance" OR "permis bateau"',
            },
            {
              concept_label: "mandatory_safety_equipment",
              query: '"équipement de sécurité plaisance"',
            },
            { concept_label: "jet_ski", query: '"moto nautique" OR "scooter des mers"' },
          ],
        });

        const { data: rawItems } = await supabaseAdmin
          .from("raw_items")
          .select("id, source_id, source_url, raw_payload, collected_at, is_official_domain, is_primary_document, traceability_level, institution_class")
          .eq("job_id", run.jobId);

        const results: unknown[] = [];
        for (const item of rawItems ?? []) {
          const payload = (item.raw_payload ?? {}) as {
            plain_text?: string;
            concept_label?: string;
            concept_query?: string;
          };
          try {
            const doc = await normalizeWithLogoriOn({
              sourceUrl: item.source_url,
              content: payload.plain_text ?? "",
            });
            const { error: insertError } = await supabaseAdmin.from("normalized_items").insert({
              raw_item_id: item.id,
              source_id: item.source_id,
              source_url: item.source_url,
              jurisdiction_hint: doc.jurisdiction_hint,
              category: doc.category,
              payload: {
                ...doc,
                concept_label: payload.concept_label,
                concept_query: payload.concept_query,
              } as unknown as never,
              is_official_domain: item.is_official_domain,
              is_primary_document: item.is_primary_document,
              traceability_level: item.traceability_level,
              institution_class: item.institution_class,
              collected_at: item.collected_at,
            });
            results.push({
              concept_label: payload.concept_label,
              url: item.source_url,
              title: doc.title,
              category: doc.category,
              jurisdiction_hint: doc.jurisdiction_hint,
              insertError: insertError?.message ?? null,
            });
          } catch (e) {
            results.push({
              concept_label: payload.concept_label,
              url: item.source_url,
              error: (e as Error).message,
            });
          }
        }

        return Response.json({ run, results });
      },
    },
  },
});
