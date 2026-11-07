import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";

import { GlowButton, StatusBadge, formatDate, inputClass } from "@/components/data-ui";
import { getDiscoveryCandidate, triageDiscoveryCandidate } from "@/lib/discovery.functions";
import type { TriageAction } from "@/lib/discovery-triage";


export function CandidatePanel({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const get = useServerFn(getDiscoveryCandidate);
  const triage = useServerFn(triageDiscoveryCandidate);
  const q = useQuery({ queryKey: ["discovery-candidate", id], queryFn: () => get({ data: { id } }) });
  const [text, setText] = useState("");

  const act = useMutation({
    mutationFn: (action: TriageAction) => {
      const c = q.data!.candidate!;
      // updated_at passed back exactly as received — the server compares it unchanged.
      return triage({ data: { id, action, text, expectedOutcome: c.outcome, expectedUpdatedAt: c.updated_at } });
    },
    onSuccess: (r) => {
      if (r.ok) {
        toast.success("Saved.");
        setText("");
        qc.invalidateQueries({ queryKey: ["discovery-candidate", id] });
        qc.invalidateQueries({ queryKey: ["discovery-candidates"] });
      } else toast.error(r.message);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const c = q.data?.candidate;
  const t = text.trim();
  const reasonOk = t.length >= 3 && t.length <= 500;

  return (
    <div className="glass-panel space-y-4 rounded-xl p-4 text-xs">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Candidate</h2>
        <button className="text-muted-foreground underline" onClick={onClose}>Close</button>
      </div>
      {q.isLoading && <p>Loading…</p>}
      {q.data && !c && <p>Candidate not found.</p>}
      {c && (
        <>
          <dl className="grid gap-1 md:grid-cols-2">
            <div><dt className="text-muted-foreground">Title</dt><dd>{c.found_title ?? "—"}</dd></div>
            <div><dt className="text-muted-foreground">Identifier</dt><dd className="font-mono">{c.found_identifier ?? "—"}</dd></div>
            <div><dt className="text-muted-foreground">Country / authority</dt><dd>{c.country_code ?? "—"} / {c.issuing_authority ?? "—"}</dd></div>
            <div><dt className="text-muted-foreground">Provider reference</dt><dd className="font-mono">{c.provider_source ? `${c.provider_source} · ${c.provider_source_id}` : "—"}</dd></div>
            <div><dt className="text-muted-foreground">State</dt><dd><StatusBadge label={`${c.stage} · ${c.outcome}`} /> {c.needs_review && <StatusBadge label="needs review" tone="warn" />}</dd></div>
            <div><dt className="text-muted-foreground">Last decision reason</dt><dd>{c.outcome_reason ?? "—"}</dd></div>
            <div><dt className="text-muted-foreground">Review note (current only, no history)</dt><dd>{c.review_note ?? "—"}</dd></div>
            <div><dt className="text-muted-foreground">Last reviewed</dt><dd>{formatDate(c.reviewed_at)}</dd></div>
          </dl>

          <div>
            <h3 className="mb-1 font-semibold">Sightings</h3>
            {(q.data?.sightings ?? []).map((s) => (
              <p key={s.id}>{formatDate(s.seen_at)} · {s.matched_key} · {s.seen_url ?? "—"}</p>
            ))}
          </div>

          <div>
            <h3 className="mb-1 font-semibold">Outcome history</h3>
            {(c.outcome_history ?? []).length === 0 && <p className="text-muted-foreground">No outcome changes yet.</p>}
            {(c.outcome_history ?? []).map((h, i) => (
              <p key={i}>{formatDate(h.at ?? undefined)} · {h.from} → {h.to}{h.to_reason ? ` — ${h.to_reason}` : ""}</p>
            ))}
          </div>

          <div className="space-y-2">
            <textarea className={inputClass} rows={2} maxLength={500} placeholder="Reason or note (required)" value={text} onChange={(e) => setText(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              {c.outcome === "open" && (
                <>
                  <GlowButton disabled={!reasonOk || act.isPending} onClick={() => act.mutate("reject")}>Reject</GlowButton>
                  <GlowButton disabled={!reasonOk || act.isPending} onClick={() => act.mutate("out_of_scope")}>Out of scope</GlowButton>
                </>
              )}
              {(c.outcome === "rejected" || c.outcome === "out_of_scope") && (
                <GlowButton disabled={!reasonOk || act.isPending} onClick={() => act.mutate("reopen")}>Reopen</GlowButton>
              )}
              <GlowButton disabled={t.length < 1 || act.isPending} onClick={() => act.mutate("flag_review")}>
                {c.needs_review ? "Update review note" : "Flag needs review"}
              </GlowButton>
              {c.needs_review && <GlowButton disabled={act.isPending} onClick={() => act.mutate("clear_review")}>Clear review flag</GlowButton>}
            </div>
            <p className="text-muted-foreground">Reasons: 3–500 characters. The review flag and note keep only their current state, with no history of their own.</p>
          </div>
        </>
      )}
    </div>
  );
}
