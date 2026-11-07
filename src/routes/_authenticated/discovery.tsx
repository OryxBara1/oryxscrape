import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, GlowButton, ScreenHeader, StatusBadge, formatDate, inputClass } from "@/components/data-ui";
import { listDiscoveryCandidates, runLdhSearch } from "@/lib/discovery.functions";
import { CandidatePanel } from "@/components/discovery-candidate-panel";

export const Route = createFileRoute("/_authenticated/discovery")({
  head: () => ({
    meta: [
      { title: "Discovery — OryxScrape" },
      { name: "description", content: "Manual staff-only LDH search producing unreviewed discovery leads." },
      { property: "og:title", content: "Discovery — OryxScrape" },
      { property: "og:description", content: "Read-only list of discovery leads returned by manual searches." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: DiscoveryScreen,
});

type RunResult = Awaited<ReturnType<typeof runLdhSearch>>;

function DiscoveryScreen() {
  const qc = useQueryClient();
  const list = useServerFn(listDiscoveryCandidates);
  const search = useServerFn(runLdhSearch);
  const [filters, setFilters] = useState({ stage: "", outcome: "", country: "" });
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = useQuery({
    queryKey: ["discovery-candidates", filters],
    queryFn: () => list({ data: { stage: filters.stage || undefined, outcome: filters.outcome || undefined, country: filters.country || undefined } }),
  });
  const [form, setForm] = useState({ q: "", namespace: "legislation", country: "", language: "", date_start: "", date_end: "" });
  const [last, setLast] = useState<RunResult | null>(null);

  const run = useMutation({
    mutationFn: () => search({ data: form }),
    onSuccess: (r) => {
      setLast(r);
      qc.invalidateQueries({ queryKey: ["discovery-candidates"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <section className="space-y-6">
      <ScreenHeader
        title="Discovery"
        description="One manual LDH search per click. Results are unreviewed leads; nothing is collected or published."
      />

      <div className="glass-panel grid gap-3 rounded-xl p-4 md:grid-cols-6">
        <input className={`${inputClass} md:col-span-2`} placeholder="Search text" maxLength={500} value={form.q} onChange={set("q")} />
        <select className={inputClass} value={form.namespace} onChange={set("namespace")}>
          <option value="legislation">legislation</option>
          <option value="case_law">case_law</option>
          <option value="doctrine">doctrine</option>
        </select>
        <input className={inputClass} placeholder="Country (MT)" value={form.country} onChange={set("country")} />
        <input className={inputClass} placeholder="Language (en)" value={form.language} onChange={set("language")} />
        <GlowButton disabled={run.isPending || !form.q.trim()} onClick={() => run.mutate()}>
          {run.isPending ? "Searching…" : "Search once"}
        </GlowButton>
        <input className={inputClass} type="date" value={form.date_start} onChange={set("date_start")} />
        <input className={inputClass} type="date" value={form.date_end} onChange={set("date_end")} />
      </div>

      <p className="text-xs text-muted-foreground">{rows.data?.quotaNote}</p>

      {last && (
        <div className="glass-panel rounded-xl p-4 text-xs space-y-1">
          <p>
            Run <span className="font-mono">{last.runId ?? "—"}</span>: <b>{last.status}</b>
            {last.errorCode ? ` (${last.errorCode})` : ""}
            {last.httpStatus ? ` · HTTP ${last.httpStatus}` : ""}
          </p>
          <p>
            {last.hitsReturned} results · {last.created} new candidates · {last.matched} matches with existing candidates ·{" "}
            {last.unusable.length} unusable · {last.conflicts.length} conflicts
          </p>
          <p>
            Local count: {last.quota.used24h}/{last.quota.limit24h} (24h) · {last.quota.used30d}/{last.quota.limit30d} (30 days).{" "}
            {last.quotaNote}
          </p>
          {last.conflicts.map((c) => (
            <p key={c.index} className="text-destructive">
              Result #{c.index + 1} matches several existing leads ({c.candidateIds.join(", ")}) — not recorded.
            </p>
          ))}
        </div>
      )}

      <div className="glass-panel grid gap-3 rounded-xl p-4 md:grid-cols-4">
        <select aria-label="Stage filter" className={inputClass} value={filters.stage} onChange={(e) => setFilters({ ...filters, stage: e.target.value })}>
          <option value="">All stages</option>
          {["lead", "identified", "source_located", "approved_for_collection", "collected", "reviewed_copy"].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select aria-label="Outcome filter" className={inputClass} value={filters.outcome} onChange={(e) => setFilters({ ...filters, outcome: e.target.value })}>
          <option value="">All outcomes</option>
          {["open", "out_of_scope", "rejected", "duplicate"].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <input aria-label="Country filter" className={inputClass} placeholder="Country (MT)" maxLength={2} value={filters.country}
          onChange={(e) => setFilters({ ...filters, country: e.target.value.toUpperCase() })} />
      </div>

      {openId && <CandidatePanel id={openId} onClose={() => setOpenId(null)} />}

      <DataTable
        headers={["Found", "Title", "Identifier", "Country / authority", "Lang / type", "Returned URL", "Confidence", "Seen", "Stage", ""]}
        empty={!rows.isLoading && (rows.data?.rows ?? []).length === 0}
      >
        {(rows.data?.rows ?? []).map((r) => (
          <tr key={r.id} className="border-b border-border/40 last:border-0 text-xs">
            <td className="px-4 py-3 text-muted-foreground">{formatDate(r.found_at)}</td>
            <td className="px-4 py-3 max-w-72">{r.found_title ?? "—"}</td>
            <td className="px-4 py-3 font-mono text-[11px]">{r.found_identifier ?? "—"}</td>
            <td className="px-4 py-3">{r.country_code ?? "—"} / {r.issuing_authority ?? "—"}</td>
            <td className="px-4 py-3">{r.language ?? "—"} / {r.doc_type_guess ?? "—"}</td>
            <td className="px-4 py-3">
              {r.found_url ? (
                <a href={r.found_url} target="_blank" rel="noreferrer noopener" className="text-primary underline">
                  Returned URL
                </a>
              ) : "—"}
            </td>
            <td className="px-4 py-3"><StatusBadge label={r.confidence} tone="warn" /></td>
            <td className="px-4 py-3">{r.sightings}</td>
            <td className="px-4 py-3">{r.stage} · {r.outcome}{r.needs_review ? " · needs review" : ""}</td>
            <td className="px-4 py-3"><button className="text-primary underline" onClick={() => setOpenId(r.id)}>Open</button></td>
          </tr>
        ))}
      </DataTable>
    </section>
  );
}
