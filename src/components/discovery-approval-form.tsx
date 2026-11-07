import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";

import { GlowButton, StatusBadge, inputClass } from "@/components/data-ui";
import { approveDiscoveryCandidate, withdrawDiscoveryApproval, type CandidateDetail } from "@/lib/discovery.functions";
import { APPROVABLE_FROM, initialProposal } from "@/lib/discovery-approval";

type Field = "title" | "identifier" | "url";

export function ApprovalForm({ c }: { c: CandidateDetail }) {
  const qc = useQueryClient();
  const approve = useServerFn(approveDiscoveryCandidate);
  const withdraw = useServerFn(withdrawDiscoveryApproval);
  const [f, setF] = useState(() => initialProposal(c));

  const token = { id: c.id, expectedOutcome: c.outcome, expectedStage: c.stage, expectedUpdatedAt: c.updated_at };
  const done = (r: { ok: boolean; message?: string }) => {
    if (r.ok) {
      toast.success("Saved.");
      qc.invalidateQueries({ queryKey: ["discovery-candidate", c.id] });
      qc.invalidateQueries({ queryKey: ["discovery-candidates"] });
    } else toast.error(r.message ?? "Not saved.");
  };
  const ap = useMutation({
    mutationFn: () => approve({ data: { ...token, title: f.title, identifier: f.identifier, sourceUrl: f.sourceUrl, confirm: f.confirm } }),
    onSuccess: done, onError: (e: Error) => toast.error(e.message),
  });
  const wd = useMutation({
    mutationFn: () => withdraw({ data: { ...token, confirmed: true } }),
    onSuccess: done, onError: (e: Error) => toast.error(e.message),
  });

  const setVal = (k: "title" | "identifier" | "sourceUrl", key: Field, v: string) =>
    setF((s) => ({ ...s, [k]: v, confirm: { ...s.confirm, [key]: false } })); // editing resets confirmation
  const toggle = (key: Field) => setF((s) => ({ ...s, confirm: { ...s.confirm, [key]: !s.confirm[key] } }));

  const row = (label: string, k: "title" | "identifier" | "sourceUrl", key: Field) => (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{label}</span>
        <StatusBadge label={f.confirm[key] ? "verified by you" : "suggested by provider"} tone={f.confirm[key] ? "ok" : "warn"} />
      </div>
      <div className="flex gap-2">
        <input className={inputClass} value={f[k]} onChange={(e) => setVal(k, key, e.target.value)} />
        <label className="flex items-center gap-1 whitespace-nowrap">
          <input type="checkbox" checked={f.confirm[key]} onChange={() => toggle(key)} disabled={!f[k]} />
          I checked the source
        </label>
      </div>
    </div>
  );

  const approvable = (APPROVABLE_FROM as readonly string[]).includes(c.stage) && c.outcome === "open" && !c.needs_review;

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <h3 className="font-semibold">Approve for collection</h3>
      <p className="text-muted-foreground">
        Approval does not create a source or start collection. "Last reviewed" shows only the last review action, not a permanent approval record.
      </p>
      {c.stage === "approved_for_collection" ? (
        <GlowButton
          disabled={wd.isPending}
          onClick={() => { if (window.confirm("Withdraw approval? The candidate goes back to 'source located'.")) wd.mutate(); }}
        >
          Withdraw approval
        </GlowButton>
      ) : (APPROVABLE_FROM as readonly string[]).includes(c.stage) ? (
        <>
          {row("Title", "title", "title")}
          {row("Identifier", "identifier", "identifier")}
          {row("Source URL (https, kept exactly)", "sourceUrl", "url")}
          {!approvable && <p className="text-muted-foreground">Needs outcome open and no needs-review flag.</p>}
          <GlowButton disabled={!approvable || ap.isPending} onClick={() => ap.mutate()}>Approve for collection</GlowButton>
          <p className="text-muted-foreground">Requires a verified title or identifier and a verified https source URL.</p>
        </>
      ) : null}
    </div>
  );
}
