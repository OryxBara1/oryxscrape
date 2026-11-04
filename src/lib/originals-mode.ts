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

/**
 * Server-side decision for the manual "Preserve original PDF — test" option.
 * The UI is never trusted: a request is honoured only in `test` mode and only
 * for staff. In `off` (or absent) mode the request is ignored, as before.
 * `isStaff` is called lazily so off-mode runs make no extra calls.
 */
export async function resolveManualStoreOriginals(input: {
  mode: OriginalsMode;
  requested: unknown;
  isStaff: () => Promise<boolean>;
}): Promise<boolean> {
  if (input.requested !== true) return false;
  if (input.mode !== "test") return false;
  if (!(await input.isStaff())) throw new Error("Staff access required to preserve originals.");
  return true;
}

/** Only boolean exposed to the browser: test mode is active AND caller is staff. */
export async function originalsTestModeVisible(input: {
  mode: OriginalsMode;
  isStaff: () => Promise<boolean>;
}): Promise<boolean> {
  if (input.mode !== "test") return false;
  return input.isStaff();
}

/**
 * ORIGINALS_INLINE_EXTRACT_MAX_BYTES: largest PDF parsed in the Worker when
 * originals mode is enabled. Anything not a positive whole number = 0 (no
 * inline parsing). Ignored when the mode is off.
 */
export function readInlineExtractCap(value: string | undefined): number {
  const v = (value ?? "").trim();
  if (!/^\d+$/.test(v)) return 0;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}
