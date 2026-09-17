import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
const s = createClient<Database>(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!);
const { data, error } = await s.rpc("get_staff_item_tier_matrix");
if (error) throw error;
const { data: srcs } = await s.from("sources").select("id,name,domain");
const { data: items } = await s.from("normalized_items").select("id,source_id,payload,created_at").gte("created_at", new Date(Date.now()-4*3600*1000).toISOString());
const byId = new Map((srcs??[]).map(x=>[x.id,x]));
for (const it of items ?? []) {
  const rows = (data as any[]).filter(r=>r.normalized_item_id===it.id);
  for (const r of rows) console.log(byId.get(it.source_id)?.name, "|", String((it.payload as any).title).slice(0,55), "|", r.profile_slug ?? r.profile_id, "→", r.resolved_tier);
}
