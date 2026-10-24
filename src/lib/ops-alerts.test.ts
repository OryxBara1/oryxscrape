import { describe, expect, it } from "vitest";

import { buildFailureEmail, OPS_ALERT_RECIPIENT } from "./ops-alerts.server";

describe("collection failure alert", () => {
  it("goes to ops@auramaris.app", () => {
    expect(OPS_ALERT_RECIPIENT).toBe("ops@auramaris.app");
  });

  it("names the affected website, reason and each attempt", () => {
    const { subject, html } = buildFailureEmail({
      url: "https://www.e-nomothesia.gr/latest",
      sourceId: "src-1",
      finalError: "HTTP 403; Parallel: empty; Webshare: timed out",
      attempts: [
        { engine: "direct", ok: false, error: "HTTP 403" },
        { engine: "parallel", ok: false, error: "empty" },
      ],
      occurredAt: new Date("2026-10-24T15:00:00Z"),
    });
    expect(subject).toContain("www.e-nomothesia.gr");
    expect(html).toContain("2026-10-24 15:00:00 UTC");
    expect(html).toContain("HTTP 403; Parallel: empty");
    expect(html).toContain("<b>parallel</b>");
  });
});
