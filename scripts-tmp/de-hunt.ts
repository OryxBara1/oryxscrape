/* One-off: targeted German statute hunt (Apify pages merged per law). */
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { runNormalizeJob } from "@/lib/normalize.server";
import { sha256Hex } from "@/lib/consumer-keys.server";

const supabase = createClient<Database>(
  process.env["SUPABASE_URL"]!,
  process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
);

const APIFY = process.env["APIFY_API_TOKEN"]!;

type Page = { url?: string; loadedUrl?: string; markdown?: string };

const LAWS = [
  { slug: "spfv", runId: "9OAK6jv3Wfb0cCvLZ", dataset: "Mt2ia6PvRk0Dh1cYd" },
  { slug: "seespbootv", runId: "ubDSBplfXh5eCNO1G", dataset: "HdTdBX9ofr98D2b7Y" },
  ...(process.env["EXTRA_LAW"]
    ? [JSON.parse(process.env["EXTRA_LAW"]) as { slug: string; runId: string; dataset: string }]
    : []),
];

function order(url: string): number {
  const m = url.match(/__(\d+)\.html/);
  if (m) return 100 + Number(m[1]);
  if (url.match(/BJNR/)) return 10;
  if (url.match(/anlage/)) return 1000;
  return 5;
}

const { data: source, error: srcErr } = await supabase
  .from("sources")
  .select("id, is_official_domain, is_primary_document, traceability_level, institution_class")
  .ilike("domain", "%gesetze-im-internet%")
  .single();
if (srcErr) throw srcErr;

for (const law of LAWS) {
  const pages = (await (
    await fetch(`https://api.apify.com/v2/datasets/${law.dataset}/items?clean=true&limit=100`, {
      headers: { Authorization: `Bearer ${APIFY}` },
    })
  ).json()) as Page[];

  const parts = pages
    .map((p) => ({ url: p.loadedUrl ?? p.url ?? "", md: (p.markdown ?? "").trim() }))
    .filter((p) => p.md.length > 200 && !/\/$/.test(p.url))
    .sort((a, b) => order(a.url) - order(b.url));

  const content = parts.map((p) => `<!-- ${p.url} -->\n${p.md}`).join("\n\n");
  const baseUrl = `https://www.gesetze-im-internet.de/${law.slug}/`;
  console.log(law.slug, "pages merged:", parts.length, "chars:", content.length);

  const { data: job, error: jobErr } = await supabase
    .from("collection_jobs")
    .insert({
      source_id: source.id,
      status: "succeeded",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      apify_run_id: law.runId,
      fetched_count: parts.length,
      new_count: 1,
      run_params: {
        actor: "apify~website-content-crawler",
        crawlerType: "playwright:firefox",
        trigger: "manual",
        mode: "targeted-hunt",
        note: "Article pages of one statute merged into a single document",
        law: law.slug,
      },
    })
    .select("id")
    .single();
  if (jobErr) throw jobErr;

  const { error: rawErr, data: raw } = await supabase
    .from("raw_items")
    .insert({
      job_id: job.id,
      source_id: source.id,
      source_url: baseUrl,
      raw_payload: { plain_text: content, document_label: law.slug, merged_pages: parts.length } as never,
      content_hash: await sha256Hex(content),
      collected_at: new Date().toISOString(),
      collection_method: "apify",
      is_official_domain: source.is_official_domain,
      is_primary_document: source.is_primary_document,
      traceability_level: source.traceability_level,
      institution_class: source.institution_class,
      canonical_url: baseUrl,
      http_status: 200,
      content_type: "text/html",
      language: "de",
      apify_actor_id: "apify~website-content-crawler",
      apify_run_id: law.runId,
      collector_version: "apify-gii-statute-merge@1.0.0",
    })
    .select("id")
    .single();
  if (rawErr) {
    console.log(law.slug, "raw insert error", rawErr.code, rawErr.message);
    continue;
  }
  console.log(law.slug, "raw_item", raw.id);

  const result = await runNormalizeJob({ supabase, jobId: job.id, limit: 5 });
  console.log(law.slug, "normalize", JSON.stringify(result));

  const { data: norm } = await supabase
    .from("normalized_items")
    .select("id, payload, category, jurisdiction_hint")
    .eq("raw_item_id", raw.id)
    .maybeSingle();
  console.log(law.slug, "title:", (norm?.payload as { title?: string } | null)?.title, "| category:", norm?.category);
}
