import { describe, expect, it, vi } from "vitest";

import { originalsTestModeVisible, readOriginalsMode, resolveManualStoreOriginals } from "./originals-mode";

const staff = () => vi.fn(async () => true);
const notStaff = () => vi.fn(async () => false);

describe("resolveManualStoreOriginals (server re-validation)", () => {
  it("mode absent: request ignored, no staff lookup", async () => {
    const isStaff = staff();
    await expect(resolveManualStoreOriginals({ mode: readOriginalsMode(undefined), requested: true, isStaff })).resolves.toBe(false);
    expect(isStaff).not.toHaveBeenCalled();
  });
  it("mode off: request ignored, no staff lookup", async () => {
    const isStaff = staff();
    await expect(resolveManualStoreOriginals({ mode: "off", requested: true, isStaff })).resolves.toBe(false);
    expect(isStaff).not.toHaveBeenCalled();
  });
  it("test mode + staff + true: honoured", async () => {
    await expect(resolveManualStoreOriginals({ mode: "test", requested: true, isStaff: staff() })).resolves.toBe(true);
  });
  it("test mode + non-staff + true: rejected", async () => {
    await expect(resolveManualStoreOriginals({ mode: "test", requested: true, isStaff: notStaff() })).rejects.toThrow(/Staff access required/);
  });
  it("test mode: unchecked or non-boolean values are not a request", async () => {
    for (const requested of [undefined, false, "true", 1, null]) {
      const isStaff = staff();
      await expect(resolveManualStoreOriginals({ mode: "test", requested, isStaff })).resolves.toBe(false);
      expect(isStaff).not.toHaveBeenCalled();
    }
  });
});

describe("originalsTestModeVisible (only boolean sent to browser)", () => {
  it("hidden when mode absent or off, without staff lookup", async () => {
    for (const v of [undefined, "off", "", "tset"]) {
      const isStaff = staff();
      await expect(originalsTestModeVisible({ mode: readOriginalsMode(v), isStaff })).resolves.toBe(false);
      expect(isStaff).not.toHaveBeenCalled();
    }
  });
  it("hidden in on mode (checkbox is a test-only control)", async () => {
    await expect(originalsTestModeVisible({ mode: "on", isStaff: staff() })).resolves.toBe(false);
  });
  it("visible only for staff in test mode", async () => {
    await expect(originalsTestModeVisible({ mode: "test", isStaff: staff() })).resolves.toBe(true);
    await expect(originalsTestModeVisible({ mode: "test", isStaff: notStaff() })).resolves.toBe(false);
  });
});
