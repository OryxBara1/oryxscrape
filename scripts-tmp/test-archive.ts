import { createClient } from "@supabase/supabase-js";
const db = createClient(process.env["SUPABASE_URL"]!, process.env["SUPABASE_SERVICE_ROLE_KEY"]!, { auth: { persistSession: false } });
const ex = await import("../src/lib/exchange.server");
const drive = await import("../src/lib/drive.server");
const { EXCHANGE_FOLDERS } = await import("../src/lib/exchange-config");

const { data: row } = await db.from("exchange_handoffs").select("id, exchange_item_id, drive_folder_id").eq("state","pending").not("drive_folder_id","is",null).limit(1).single();
console.log("testing on", row);
const res = await ex.markHandoffProcessed(db as never, null, { handoffId: row!.id, note: "automated verification run" });
console.log("archived:", res);

const after = await db.from("exchange_handoffs").select("state, processed_at, drive_processed_folder_id, processed_note").eq("id", row!.id).single();
console.log("db row:", after.data);
const inProcessed = await drive.listFolderInDrive(res.driveProcessedFolderId, "0AOesw6uCeLquUk9PVA");
console.log("in _processed:", inProcessed.map(f=>f.name));
const audit = await db.from("audit_events").select("check_type, run_at, findings").eq("target_id", row!.id).eq("check_type","exchange_archive").order("run_at",{ascending:false}).limit(1);
console.log("audit:", JSON.stringify(audit.data));

// revert
await drive.moveFile({ fileId: row!.drive_folder_id!, addParentId: EXCHANGE_FOLDERS.pendingReview, removeParentId: res.driveProcessedFolderId });
await db.from("exchange_handoffs").update({ state: "pending", processed_at: null, processed_by: null, processed_note: null, drive_processed_folder_id: null }).eq("id", row!.id);
await db.from("audit_events").delete().eq("target_id", row!.id).eq("check_type","exchange_archive");
console.log("reverted");
