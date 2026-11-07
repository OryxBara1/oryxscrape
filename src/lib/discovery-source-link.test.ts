import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  collectionRouteOf, createAndLinkCore, isCompatibleSource, linkCore, listCompatibleCore, unlinkCore,
  validateCreateInput, validateLinkInput, validateUnlinkInput,
  type LinkCandidate, type LinkStore, type NewSourcePayload, type SourceRow,
} from "./discovery-source-link";

const CID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";
const NEWID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "2026-11-07T01:00:00.123456+00:00";
const NOW = new Date("2026-11-07T02:00:00.000Z");
const URL_ = "https://legislation.mt/eli/cap/283/eng";

const src = (o: Partial<SourceRow> = {}): SourceRow => ({
  id: SID, name: "legislation.mt Cap. 283", domain: "legislation.mt", start_url: URL_, collection_method: "http",
  is_active: true, schedule_enabled: false, is_official_domain: true, is_primary_document: true,
  traceability_level: "direct_url", institution_class: "government", tos_status: "unknown", robots_status: "unknown", ...o,
});

function mock(cand: Partial<LinkCandidate> = {}, sources: SourceRow[] = [src()], staff = true) {
  const row: LinkCandidate = {
    id: CID, stage: "approved_for_collection", outcome: "open", needs_review: false, updated_at: TOKEN,
    source_id: null, collection_job_id: null, raw_item_id: null, retrieval_state: "none", confirmed_source_url: URL_, ...cand,
  };
  const inserts: NewSourcePayload[] = [];
  const patches: Record<string, unknown>[] = [];
  const all = [...sources];
  const store: LinkStore = {
    isStaff: vi.fn(async () => staff),
    readCandidate: vi.fn(async () => ({ ...row })),
    readSource: vi.fn(async (id: string) => all.find((s) => s.id === id) ?? null),
    listSources: vi.fn(async () => all),
    findSource: vi.fn(async (d: string, u: string) => all.find((s) => s.domain === d && s.start_url === u) ?? null),
    insertSource: vi.fn(async (p: NewSourcePayload) => {
      if (all.some((s) => s.domain === p.domain && s.start_url === p.start_url)) return "duplicate" as const;
      inserts.push(p);
      all.push({ ...src(), ...p, id: NEWID });
      return { id: NEWID };
    }),
    updateCandidate: vi.fn(async (_id, g, patch) => {
      if (g.updated_at !== row.updated_at || g.stage !== row.stage || g.outcome !== row.outcome || g.needs_review !== row.needs_review || g.source_id !== row.source_id) return 0;
      if (g.noJobNoRawNone && (row.collection_job_id || row.raw_item_id || row.retrieval_state !== "none")) return 0;
      patches.push(patch as Record<string, unknown>);
      Object.assign(row, patch);
      row.updated_at = "2026-11-07T02:00:01.000001+00:00";
      return 1;
    }),
  };
  return { store, row, inserts, patches, all };
}
const deps = (s: LinkStore) => ({ store: s, userId: "staff-user", now: () => NOW });
const linkIn = (o: Record<string, unknown> = {}) =>
  validateLinkInput({ id: CID, expectedUpdatedAt: TOKEN, sourceId: SID, candidateUrl: URL_, sourceUrl: URL_, ...o });
const createIn = (o: Record<string, unknown> = {}) =>
  validateCreateInput({
    id: CID, expectedUpdatedAt: TOKEN, candidateUrl: URL_, name: "legislation.mt Cap. 283",
    is_official_domain: true, is_primary_document: true, traceability_level: "direct_url",
    institution_class: "government", tos_status: "unknown", robots_status: "unknown", ...o,
  });

describe("routing rule mirrors startCollectionJob", () => {
  it("branch order: transport.gov.mt includes -> malta, api, http, else apify", () => {
    expect(collectionRouteOf({ start_url: "https://www.transport.gov.mt/x", collection_method: "http" })).toBe("malta");
    expect(collectionRouteOf({ start_url: "https://example.org/?r=transport.gov.mt", collection_method: "http" })).toBe("malta");
    expect(collectionRouteOf({ start_url: "https://a.it", collection_method: "api" })).toBe("api");
    expect(collectionRouteOf({ start_url: "https://a.mt", collection_method: "http" })).toBe("http");
    expect(collectionRouteOf({ start_url: "https://a.mt", collection_method: "apify" })).toBe("apify");
    expect(collectionRouteOf({ start_url: "https://a.mt", collection_method: "manual" })).toBe("apify");
  });

  it("startCollectionJob still uses the same includes check and branch order (drift guard)", () => {
    const code = readFileSync(new URL("./collection.functions.ts", import.meta.url), "utf8");
    const i = code.indexOf('source.start_url.includes("transport.gov.mt")');
    const a = code.indexOf('source.collection_method === "api"');
    const h = code.indexOf('source.collection_method === "http"');
    expect(i).toBeGreaterThan(0);
    expect(a).toBeGreaterThan(i);
    expect(h).toBeGreaterThan(a);
  });

  it("listing and linking apply the same rule to every fixture", async () => {
    const fixtures = [
      src({ id: "a0000000-0000-4000-8000-000000000001" }),
      src({ id: "a0000000-0000-4000-8000-000000000002", collection_method: "apify" }),
      src({ id: "a0000000-0000-4000-8000-000000000003", collection_method: "api" }),
      src({ id: "a0000000-0000-4000-8000-000000000004", is_active: false }),
      src({ id: "a0000000-0000-4000-8000-000000000005", schedule_enabled: true }),
      src({ id: "a0000000-0000-4000-8000-000000000006", start_url: "https://www.transport.gov.mt/doc.pdf", domain: "transport.gov.mt" }),
    ];
    for (const f of fixtures) {
      const m = mock({}, fixtures);
      const listed = (await listCompatibleCore(deps(m.store))).some((s) => s.id === f.id);
      const r = await linkCore(linkIn({ sourceId: f.id, sourceUrl: f.start_url, confirmUrlMismatch: true }), deps(m.store));
      expect(listed).toBe(isCompatibleSource(f));
      expect(r.ok).toBe(listed);
      if (!listed) expect(r).toMatchObject({ code: "incompatible" });
    }
  });
});

describe("link existing source", () => {
  it("links; patch keys exact; reviewer from server; no other write", async () => {
    const m = mock();
    expect(await linkCore(linkIn({ reviewed_by: "attacker" }), deps(m.store))).toEqual({ ok: true, sourceId: SID });
    expect(m.patches).toEqual([{ source_id: SID, reviewed_by: "staff-user", reviewed_at: NOW.toISOString() }]);
    expect(m.store.insertSource).not.toHaveBeenCalled();
    expect(m.row).toMatchObject({ stage: "approved_for_collection", retrieval_state: "none", collection_job_id: null, raw_item_id: null });
  });

  it.each([
    ["not approved", { stage: "source_located" }],
    ["closed outcome", { outcome: "rejected" }],
    ["needs review", { needs_review: true }],
    ["already linked", { source_id: SID }],
  ])("refuses when %s, no write", async (_n, o) => {
    const m = mock(o as Partial<LinkCandidate>);
    expect(await linkCore(linkIn(), deps(m.store))).toMatchObject({ ok: false, code: "not_eligible" });
    expect(m.store.updateCandidate).not.toHaveBeenCalled();
  });

  it("stale updated_at -> conflict, no write", async () => {
    const m = mock();
    expect(await linkCore(linkIn({ expectedUpdatedAt: "2026-11-07T01:00:00.123+00:00" }), deps(m.store))).toMatchObject({ code: "conflict" });
    expect(m.store.updateCandidate).not.toHaveBeenCalled();
  });

  it("change between read and update -> conflict, single attempt", async () => {
    const m = mock();
    (m.store.updateCandidate as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0);
    expect(await linkCore(linkIn(), deps(m.store))).toMatchObject({ code: "conflict" });
    expect(m.store.updateCandidate).toHaveBeenCalledTimes(1);
  });

  it("different URLs require explicit confirmation; neither URL changes", async () => {
    const other = src({ start_url: "https://legislation.mt/eli/cap/234/eng" });
    const m = mock({}, [other]);
    const base = { sourceUrl: other.start_url };
    expect(await linkCore(linkIn(base), deps(m.store))).toMatchObject({ code: "url_mismatch" });
    expect(m.store.updateCandidate).not.toHaveBeenCalled();
    expect(await linkCore(linkIn({ ...base, confirmUrlMismatch: true }), deps(m.store))).toMatchObject({ ok: true });
    expect(m.row.confirmed_source_url).toBe(URL_);
    expect(m.all[0]!.start_url).toBe(other.start_url);
  });

  it("refuses if either shown URL no longer matches current rows", async () => {
    const m = mock();
    expect(await linkCore(linkIn({ candidateUrl: "https://legislation.mt/eli/cap/283/mlt", confirmUrlMismatch: true }), deps(m.store))).toMatchObject({ code: "conflict" });
    expect(await linkCore(linkIn({ sourceUrl: "https://legislation.mt/old", confirmUrlMismatch: true }), deps(m.store))).toMatchObject({ code: "conflict" });
    expect(m.store.updateCandidate).not.toHaveBeenCalled();
  });

  it("non-staff refused before any read or write", async () => {
    const m = mock({}, [src()], false);
    await expect(linkCore(linkIn(), deps(m.store))).rejects.toThrow(/staff/);
    await expect(createAndLinkCore(createIn(), deps(m.store))).rejects.toThrow(/staff/);
    await expect(unlinkCore(validateUnlinkInput({ id: CID, expectedUpdatedAt: TOKEN, sourceId: SID }), deps(m.store))).rejects.toThrow(/staff/);
    await expect(listCompatibleCore(deps(m.store))).rejects.toThrow(/staff/);
    expect(m.store.readCandidate).not.toHaveBeenCalled();
    expect(m.store.insertSource).not.toHaveBeenCalled();
  });
});

describe("create http source and link", () => {
  it("sends method http + schedule false explicitly; URL exact; domain derived; allowlist keys only", async () => {
    const m = mock({}, []);
    expect(await createAndLinkCore(createIn({ collection_method: "apify", schedule_enabled: true }), deps(m.store))).toEqual({ ok: true, sourceId: NEWID });
    expect(Object.keys(m.inserts[0]!).sort()).toEqual([
      "collection_method", "domain", "institution_class", "is_active", "is_official_domain", "is_primary_document",
      "name", "robots_status", "schedule_enabled", "start_url", "tos_status", "traceability_level",
    ]);
    expect(m.inserts[0]).toMatchObject({ collection_method: "http", schedule_enabled: false, is_active: true, start_url: URL_, domain: "legislation.mt" });
    expect(m.patches).toEqual([{ source_id: NEWID, reviewed_by: "staff-user", reviewed_at: NOW.toISOString() }]);
  });

  it.each(["is_official_domain", "is_primary_document", "traceability_level", "institution_class", "tos_status", "robots_status"])(
    "missing %s is refused (no DB default fallback)", (k) => {
      expect(() => createIn({ [k]: undefined })).toThrow();
    },
  );

  it("'unknown' is accepted when that is the real knowledge", () => {
    expect(createIn({ institution_class: "unknown", tos_status: "unknown" }).institution_class).toBe("unknown");
  });

  it("checks eligibility and token BEFORE inserting", async () => {
    const a = mock({ needs_review: true }, []);
    expect(await createAndLinkCore(createIn(), deps(a.store))).toMatchObject({ code: "not_eligible" });
    const b = mock({}, []);
    expect(await createAndLinkCore(createIn({ expectedUpdatedAt: "old" }), deps(b.store))).toMatchObject({ code: "conflict" });
    const c = mock({}, []);
    expect(await createAndLinkCore(createIn({ candidateUrl: "https://other.mt/x" }), deps(c.store))).toMatchObject({ code: "conflict" });
    for (const m of [a, b, c]) expect(m.store.insertSource).not.toHaveBeenCalled();
  });

  it("refuses a URL routed to the Malta chain; nothing inserted", async () => {
    const m = mock({ confirmed_source_url: "https://www.transport.gov.mt/a.pdf" }, []);
    expect(await createAndLinkCore(createIn({ candidateUrl: "https://www.transport.gov.mt/a.pdf" }), deps(m.store))).toMatchObject({ code: "incompatible" });
    expect(m.store.insertSource).not.toHaveBeenCalled();
  });

  it("UNIQUE(domain,start_url): no duplicate, existing source returned, candidate unchanged", async () => {
    const m = mock({}, [src()]);
    const r = await createAndLinkCore(createIn(), deps(m.store));
    expect(r).toMatchObject({ ok: false, code: "exists", existingSource: { id: SID } });
    expect(m.inserts).toHaveLength(0);
    expect(m.store.updateCandidate).not.toHaveBeenCalled();
    expect(m.all[0]).toEqual(src());
  });

  it("created but link refused -> createdSourceId; recovery links it without a second insert", async () => {
    const m = mock({}, []);
    (m.store.updateCandidate as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0);
    const r = await createAndLinkCore(createIn(), deps(m.store));
    expect(r).toMatchObject({ ok: false, code: "conflict", createdSourceId: NEWID });
    expect(m.inserts).toHaveLength(1);
    expect(await linkCore(linkIn({ sourceId: NEWID }), deps(m.store))).toMatchObject({ ok: true, sourceId: NEWID });
    expect(m.inserts).toHaveLength(1);
    // a second create attempt hits the unique key and never re-creates
    m.row.source_id = null;
    expect(await createAndLinkCore(createIn({ expectedUpdatedAt: m.row.updated_at }), deps(m.store))).toMatchObject({ code: "exists" });
    expect(m.inserts).toHaveLength(1);
  });
});

describe("unlink", () => {
  const un = (o: Record<string, unknown> = {}) => validateUnlinkInput({ id: CID, expectedUpdatedAt: TOKEN, sourceId: SID, ...o });

  it("clears only source_id; source untouched", async () => {
    const m = mock({ source_id: SID });
    expect(await unlinkCore(un(), deps(m.store))).toEqual({ ok: true });
    expect(m.patches).toEqual([{ source_id: null, reviewed_by: "staff-user", reviewed_at: NOW.toISOString() }]);
    expect(m.all).toEqual([src()]);
  });

  it.each([
    ["job linked", { collection_job_id: NEWID }],
    ["raw item linked", { raw_item_id: NEWID }],
    ["retrieval in progress", { retrieval_state: "in_progress" }],
  ])("blocked when %s", async (_n, o) => {
    const m = mock({ source_id: SID, ...o } as Partial<LinkCandidate>);
    expect(await unlinkCore(un(), deps(m.store))).toMatchObject({ code: "not_eligible" });
    expect(m.store.updateCandidate).not.toHaveBeenCalled();
  });

  it("stale token or different source -> conflict", async () => {
    const m = mock({ source_id: SID });
    expect(await unlinkCore(un({ expectedUpdatedAt: "old" }), deps(m.store))).toMatchObject({ code: "conflict" });
    expect(await unlinkCore(un({ sourceId: NEWID }), deps(m.store))).toMatchObject({ code: "conflict" });
    expect(m.store.updateCandidate).not.toHaveBeenCalled();
  });
});

describe("isolation", () => {
  it("module does not import or call collection, sources functions or external services", () => {
    const code = readFileSync(new URL("./discovery-source-link.ts", import.meta.url), "utf8");
    expect(code).not.toMatch(/^import /m);
    expect(code).not.toMatch(/startCollectionJob\(|createSource\(|updateSource\(|fetch\(|storeOriginals/);
    // patch contents (only source_id + reviewer) are asserted exactly in the link/create/unlink tests
  });
});
