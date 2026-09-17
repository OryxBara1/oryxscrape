/* One-off: create NL / MT / CY sources and run their targeted hunts. */
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { runPdfCollection } from "@/lib/pdf-collect.server";
import { runNormalizeJob } from "@/lib/normalize.server";

const supabase = createClient<Database>(
  process.env["SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
);

type Facts = Pick<
  Database["public"]["Tables"]["sources"]["Insert"],
  "is_official_domain" | "is_primary_document" | "traceability_level" | "institution_class"
>;

const official: Facts = {
  is_official_domain: true,
  is_primary_document: true,
  traceability_level: "direct_url",
  institution_class: "government",
};

const plan = [
  {
    name: "wetten.overheid.nl — Netherlands",
    domain: "wetten.overheid.nl",
    start_url: "https://wetten.overheid.nl/BWBR0003628/",
    language: "nl",
    facts: official,
    targets: [
      { url: "https://wetten.overheid.nl/BWBR0003628/", document_label: "Binnenvaartpolitiereglement (BWBR0003628)" },
      { url: "https://wetten.overheid.nl/BWBR0037546/", document_label: "Wet pleziervaartuigen 2016 (BWBR0037546)" },
    ],
  },
  {
    name: "legislation.mt — Malta",
    domain: "legislation.mt",
    start_url: "https://legislation.mt/eli/cap/234/eng",
    language: "en",
    facts: official,
    targets: [
      {
        url: "https://legislation.mt/getpdf/67fcbc94cf7b7f23782848d4",
        document_label: "Merchant Shipping Act, Chapter 234 (eli/cap/234)",
      },
    ],
  },
  {
    name: "cylaw.org — Cyprus",
    domain: "cylaw.org",
    start_url: "https://www.cylaw.org/nomoi/",
    language: "el",
    facts: {
      is_official_domain: false,
      is_primary_document: true,
      traceability_level: "domain_indicated",
      institution_class: "professional_body",
    } as Facts,
    targets: [
      {
        url: "https://www.cylaw.org/nomoi/arith/2026_1_004.pdf",
        document_label: "N. 4(I)/2026 — Ο περί Ναυσιπλοΐας Αναψυχής Νόμος του 2026",
      },
    ],
  },
];

for (const entry of plan) {
  let { data: source } = await supabase
    .from("sources")
    .select("id, is_official_domain, is_primary_document, traceability_level, institution_class")
    .eq("domain", entry.domain)
    .maybeSingle();

  if (!source) {
    const { data, error } = await supabase
      .from("sources")
      .insert({
        name: entry.name,
        domain: entry.domain,
        start_url: entry.start_url,
        collection_method: "http",
        is_active: true,
        ...entry.facts,
      })
      .select("id, is_official_domain, is_primary_document, traceability_level, institution_class")
      .single();
    if (error) throw error;
    source = data;
    console.log("created source", entry.name, source.id);
  } else {
    console.log("existing source", entry.name, source.id);
  }

  const result = await runPdfCollection({
    supabase,
    source,
    profileId: null,
    targets: entry.targets,
    language: entry.language,
  });
  console.log(entry.name, "collect:", JSON.stringify(result.perTarget, null, 1));

  const norm = await runNormalizeJob({ supabase, jobId: result.jobId, limit: 5 });
  console.log(entry.name, "normalize:", JSON.stringify(norm));

  const { data: rows } = await supabase
    .from("normalized_items")
    .select("id, source_url, category, jurisdiction_hint, payload, verification_status, publication_status")
    .eq("source_id", source.id);
  for (const r of rows ?? []) {
    console.log(
      " →",
      (r.payload as { title?: string }).title,
      "| cat:",
      r.category,
      "| jur:",
      r.jurisdiction_hint,
      "|",
      r.verification_status,
      r.publication_status,
    );
  }
}
