const G="https://connector-gateway.lovable.dev/google_drive/drive/v3";
const h={Authorization:`Bearer ${process.env["LOVABLE_API_KEY"]}`,"X-Connection-Api-Key":process.env["GOOGLE_DRIVE_API_KEY"]!};
const { createClient } = await import("@supabase/supabase-js");
const db = createClient(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, {auth:{persistSession:false}});
const { data: row } = await db.from("exchange_handoffs").select("id, drive_folder_id").eq("state","pending").not("drive_folder_id","is",null).limit(1).single();
for (const id of [row!.drive_folder_id!, "1mTL8uCeCeVk7ea1M_mW3Zy1-i3gNalbi"]) {
  const r = await fetch(`${G}/files/${id}?supportsAllDrives=true&fields=id,name,capabilities`,{headers:h});
  console.log(id, JSON.stringify(await r.json()).slice(0,900));
}
