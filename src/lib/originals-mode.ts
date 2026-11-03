/**
 * Switch for preserving original PDF files (Phase 1B step 3a).
 *
 * ORIGINALS_STORAGE_MODE (server env):
 *   unset / "off" (default) → collectors behave exactly as before; the storage
 *                              module is never loaded.
 *   "test"                 → only manual runs that explicitly ask for it.
 *   "on"                   → manual and scheduled runs.
 */
export type OriginalsMode = "off" | "test" | "on";

export function readOriginalsMode(value: string | undefined): OriginalsMode {
  const v = (value ?? "").trim().toLowerCase();
  return v === "test" || v === "on" ? v : "off";
}

export function shouldStoreOriginals(
  mode: OriginalsMode,
  trigger: "manual" | "scheduled",
  requested: boolean | undefined,
): boolean {
  if (mode === "on") return true;
  if (mode === "test") return trigger === "manual" && requested === true;
  return false;
}
