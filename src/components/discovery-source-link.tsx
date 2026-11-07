import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";

import { GlowButton, StatusBadge, inputClass } from "@/components/data-ui";
import {
  createSourceForCandidate, linkCandidateSource, listCompatibleSources, unlinkCandidateSource, type CandidateDetail,
} from "@/lib/discovery.functions";
import {
  INSTITUTION, ROBOTS, SOURCE_DB_DEFAULTS, TOS, TRACEABILITY, type LinkResult, type SourceRow,
} from "@/lib/discovery-source-link";

function SourceSummary({ s }: { s: SourceRow }) {
  return (
    <div className="rounded border border-border p-2">
      <p className="font-semibold">{s.name}</p>
      <p className="font-mono break-all">{s.start_url}</p>
      <p>method {s.collection_method} · {s.is_active ? "active" : "inactive"} · {s.schedule_enabled ? "scheduled" : "manual only"}</p>
      <p>official domain {String(s.is_official_domain)} · primary document {String(s.is_primary_document)} · {s.traceability_level} · {s.institution_class} · terms {s.tos_status} · robots {s.robots_status}</p>
    </div>
  );
}

const sel = (v: string, set: (v: string) => void, opts: readonly string[], hint: string) => (
  <select className={inputClass} value={v} onChange={(e) => set(e.target.value)}>
    <option value="">— choose (DB default: {hint}) —</option>
    {opts.map((o) => <option key={o} value={o}>{o}</option>)}
  </select>
);
const yn = (v: string, set: (v: string) => void, hint: boolean) => sel(v, set, ["true", "false"], String(hint));

export function SourceLinkPanel({ c }: { c: CandidateDetail }) {
  const qc = useQueryClient();
  const list = useServerFn(listCompatibleSources);
  const link = useServerFn(linkCandidateSource);
  const create = useServerFn(createSourceForCandidate);
  const unlink = useServerFn(unlinkCandidateSource);
  const eligible = c.stage === "approved_for_collection" && c.outcome === "open" && !c.needs_review;
  const sources = useQuery({ queryKey: ["compatible-sources"], queryFn: () => list(), enabled: eligible });
  const [pick, setPick] = useState("");
  const [mismatchOk, setMismatchOk] = useState(false);
  const [recoverId, setRecoverId] = useState<string | null>(null);
  const [f, setF] = useState({ name: "", notes: "", off: "", prim: "", trace: "", inst: "", tos: "", rob: "" });
  const D = SOURCE_DB_DEFAULTS;

  const done = (r: LinkResult) => {
    if (r.ok) {
      toast.success("Saved. No collection was started.");
      qc.invalidateQueries({ queryKey: ["discovery-candidate", c.id] });
      qc.invalidateQueries({ queryKey: ["compatible-sources"] });
    } else {
      if (r.createdSourceId) setRecoverId(r.createdSourceId);
      if (r.existingSource) setPick(r.existingSource.id);
      toast.error(r.message);
      qc.invalidateQueries({ queryKey: ["compatible-sources"] });
    }
  };
  const token = { id: c.id, expectedUpdatedAt: c.updated_at };
  const all = sources.data ?? [];
  const chosen = all.find((s) => s.id === pick) ?? null;
  const differs = !!chosen && chosen.start_url !== c.confirmed_source_url;

  const doLink = useMutation({
    mutationFn: (s: SourceRow) => link({ data: { ...token, sourceId: s.id, candidateUrl: c.confirmed_source_url ?? "", sourceUrl: s.start_url, confirmUrlMismatch: mismatchOk } }),
    onSuccess: done, onError: (e: Error) => toast.error(e.message),
  });
  const doCreate = useMutation({
    mutationFn: () => create({ data: {
      ...token, candidateUrl: c.confirmed_source_url ?? "", name: f.name, notes: f.notes,
      ...(f.off ? { is_official_domain: f.off === "true" } : {}),
      ...(f.prim ? { is_primary_document: f.prim === "true" } : {}),
      traceability_level: f.trace, institution_class: f.inst, tos_status: f.tos, robots_status: f.rob,
    } }),
    onSuccess: done, onError: (e: Error) => toast.error(e.message),
  });
  const doUnlink = useMutation({
    mutationFn: () => unlink({ data: { ...token, sourceId: c.source_id! } }),
    onSuccess: done, onError: (e: Error) => toast.error(e.message),
  });

  if (c.source_id) {
    const blocked = !!c.collection_job_id || !!c.raw_item_id || c.retrieval_state !== "none";
    return (
      <div className="space-y-2 border-t border-border pt-3">
        <h3 className="font-semibold">Source</h3>
        <p>Linked source: <span className="font-mono">{c.source_id}</span></p>
        <p className="text-muted-foreground">Linking a source does not start collection. Withdrawing approval requires unlinking first.</p>
        <GlowButton disabled={blocked || doUnlink.isPending} onClick={() => { if (window.confirm("Unlink this source? The source itself is kept.")) doUnlink.mutate(); }}>
          Unlink source
        </GlowButton>
        {blocked && <p className="text-muted-foreground">Cannot unlink: a collection is already associated.</p>}
      </div>
    );
  }
  if (!eligible) return null;
  const createReady = f.name.trim().length >= 3 && f.off && f.prim && f.trace && f.inst && f.tos && f.rob;

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <h3 className="font-semibold">Link a source</h3>
      <p className="text-muted-foreground">Linking a source does not start collection. Candidate URL: <span className="font-mono break-all">{c.confirmed_source_url}</span></p>
      {recoverId && (
        <div className="space-y-1">
          <StatusBadge label="Source created but not linked" tone="warn" />
          <p>Reload the candidate, then pick source <span className="font-mono">{recoverId}</span> below to link it. No new source will be created.</p>
        </div>
      )}
      <div className="space-y-1">
        <span className="text-muted-foreground">Existing compatible sources (http, active, manual only)</span>
        <select className={inputClass} value={pick} onChange={(e) => { setPick(e.target.value); setMismatchOk(false); }}>
          <option value="">— choose —</option>
          {all.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        {chosen && <SourceSummary s={chosen} />}
        {differs && (
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={mismatchOk} onChange={(e) => setMismatchOk(e.target.checked)} />
            The source start URL differs from the candidate URL — link anyway (neither URL is changed).
          </label>
        )}
        <GlowButton disabled={!chosen || (differs && !mismatchOk) || doLink.isPending} onClick={() => chosen && doLink.mutate(chosen)}>Link this source</GlowButton>
      </div>
      <div className="space-y-1">
        <span className="text-muted-foreground">Or create a new http source for the candidate URL (manual only, no schedule)</span>
        <input className={inputClass} placeholder="Source name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <div className="grid gap-1 md:grid-cols-2">
          <label>Official domain {yn(f.off, (v) => setF({ ...f, off: v }), D.is_official_domain)}</label>
          <label>Primary document {yn(f.prim, (v) => setF({ ...f, prim: v }), D.is_primary_document)}</label>
          <label>Traceability {sel(f.trace, (v) => setF({ ...f, trace: v }), TRACEABILITY, D.traceability_level)}</label>
          <label>Institution {sel(f.inst, (v) => setF({ ...f, inst: v }), INSTITUTION, D.institution_class)}</label>
          <label>Terms of service {sel(f.tos, (v) => setF({ ...f, tos: v }), TOS, D.tos_status)}</label>
          <label>Robots {sel(f.rob, (v) => setF({ ...f, rob: v }), ROBOTS, D.robots_status)}</label>
        </div>
        <input className={inputClass} placeholder="Notes (optional)" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        <GlowButton disabled={!createReady || doCreate.isPending} onClick={() => doCreate.mutate()}>Create source and link</GlowButton>
      </div>
    </div>
  );
}
