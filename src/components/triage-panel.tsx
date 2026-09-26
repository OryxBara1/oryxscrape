import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ExternalLink, Eye } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { DataTable, Field, GlowButton, StatusBadge, inputClass } from "@/components/data-ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  APPLICATION_LABELS,
  APPLICATION_STATUSES,
  COVERED_JURISDICTIONS,
  DOC_TYPE_LABELS,
  TRIAGE_LABELS,
  type ApplicationStatus,
  type DocType,
  type TriageState,
} from "@/lib/curation";
import {
  getItemDetail,
  listTriageItems,
  rejectItems,
  saveItemCuration,
  setItemReviewState,
  type TriageFilters,
} from "@/lib/items.functions";

export type TriageSearch = {
  jur?: string;
  state?: string;
  domain?: string;
  type?: string;
  app?: string;
  from?: string;
  to?: string;
  q?: string;
};

const STATE_TONE: Record<TriageState, string> = {
  discovered: "neutral",
  rejected: "bad",
  reviewed_partial: "warn",
  reviewed_scoped: "ok",
  approved: "live",
  sent: "live",
  archived: "neutral",
};

export function TriagePanel({
  search,
  onSearch,
}: {
  search: TriageSearch;
  onSearch: (patch: Partial<TriageSearch>) => void;
}) {
  const qc = useQueryClient();
  const fetchList = useServerFn(listTriageItems);
  const doReject = useServerFn(rejectItems);
  const [qDraft, setQDraft] = useState(search.q ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [batchReason, setBatchReason] = useState("");

  useEffect(() => setQDraft(search.q ?? ""), [search.q]);

  const filters: TriageFilters = {
    jurisdiction: search.jur ?? null,
    state: search.state ?? null,
    domain: search.domain ?? null,
    docType: search.type ?? null,
    application: search.app ?? null,
    dateFrom: search.from ?? null,
    dateTo: search.to ?? null,
    q: search.q ?? null,
  };
  const list = useQuery({
    queryKey: ["triage", filters],
    queryFn: () => fetchList({ data: filters }),
  });
  const rows = list.data ?? [];
  const domains = Array.from(new Set(rows.map((r) => r.domain).filter(Boolean))) as string[];

  const batch = useMutation({
    mutationFn: () =>
      doReject({ data: { normalizedItemIds: Array.from(selected), reason: batchReason } }),
    onSuccess: (res) => {
      toast.success(`${res.rejected} item(s) rejeitado(s).`);
      if (res.failed.length) toast.error(`${res.failed.length} falharam: ${res.failed[0]?.error}`);
      setSelected(new Set());
      setBatchReason("");
      qc.invalidateQueries({ queryKey: ["triage"] });
      qc.invalidateQueries({ queryKey: ["tier-matrix"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rejectable = rows.filter((r) => r.state === "discovered" || r.state.startsWith("reviewed_"));

  return (
    <div className="space-y-4">
      <div className="glass-panel grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Busca (CELEX, título, tag)">
          <input
            className={inputClass}
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSearch({ q: qDraft || undefined })}
            onBlur={() => qDraft !== (search.q ?? "") && onSearch({ q: qDraft || undefined })}
            placeholder="32013L0053"
          />
        </Field>
        <Field label="Jurisdição">
          <select className={inputClass} value={search.jur ?? ""} onChange={(e) => onSearch({ jur: e.target.value || undefined })}>
            <option value="">Todas</option>
            <option value="EU">EU (supranacional)</option>
            {["ES", "FR", "IT", "HR", "PT", "GR", "MT", "CY", "NL", "DE", "GB", "BR"].map((j) => (
              <option key={j} value={j}>{j}</option>
            ))}
          </select>
        </Field>
        <Field label="Estado">
          <select className={inputClass} value={search.state ?? ""} onChange={(e) => onSearch({ state: e.target.value || undefined })}>
            <option value="">Todos</option>
            {(Object.keys(TRIAGE_LABELS) as TriageState[]).map((s) => (
              <option key={s} value={s}>{TRIAGE_LABELS[s]}</option>
            ))}
          </select>
        </Field>
        <Field label="Fonte">
          <select className={inputClass} value={search.domain ?? ""} onChange={(e) => onSearch({ domain: e.target.value || undefined })}>
            <option value="">Todas</option>
            {Array.from(new Set([...(search.domain ? [search.domain] : []), ...domains])).map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        </Field>
        <Field label="Tipo de ato">
          <select className={inputClass} value={search.type ?? ""} onChange={(e) => onSearch({ type: e.target.value || undefined })}>
            <option value="">Todos</option>
            {(Object.keys(DOC_TYPE_LABELS) as DocType[]).map((t) => (
              <option key={t} value={t}>{DOC_TYPE_LABELS[t]}</option>
            ))}
          </select>
        </Field>
        <Field label="Estado de aplicação">
          <select className={inputClass} value={search.app ?? ""} onChange={(e) => onSearch({ app: e.target.value || undefined })}>
            <option value="">Todos</option>
            {APPLICATION_STATUSES.map((a) => (
              <option key={a} value={a}>{APPLICATION_LABELS[a]}</option>
            ))}
          </select>
        </Field>
        <Field label="Data de">
          <input type="date" className={inputClass} value={search.from ?? ""} onChange={(e) => onSearch({ from: e.target.value || undefined })} />
        </Field>
        <Field label="Data até">
          <input type="date" className={inputClass} value={search.to ?? ""} onChange={(e) => onSearch({ to: e.target.value || undefined })} />
        </Field>
      </div>

      {selected.size > 0 ? (
        <div className="glass-panel flex flex-wrap items-end gap-3 p-4">
          <p className="text-sm">{selected.size} selecionado(s) — rejeição em lote (nunca aprovação).</p>
          <input
            className={`${inputClass} min-w-64 flex-1`}
            value={batchReason}
            onChange={(e) => setBatchReason(e.target.value)}
            placeholder="Motivo da rejeição (obrigatório)"
          />
          <GlowButton
            variant="ghost"
            disabled={!batchReason.trim() || batch.isPending}
            onClick={() => {
              if (window.confirm(`Rejeitar ${selected.size} item(s)? Cada um gera um evento de auditoria.`)) batch.mutate();
            }}
          >
            Rejeitar {selected.size}
          </GlowButton>
          <GlowButton variant="ghost" onClick={() => setSelected(new Set())}>Limpar</GlowButton>
        </div>
      ) : null}

      {list.error ? <div className="glass-panel p-4 text-sm text-destructive">{(list.error as Error).message}</div> : null}

      <p className="text-xs text-muted-foreground">{list.isLoading ? "Carregando…" : `${rows.length} item(s)`}</p>

      <DataTable
        headers={["", "Ato", "Tipo / data", "Fonte", "Estado", "Escopo", ""]}
        loading={list.isLoading}
        empty={!list.isLoading && rows.length === 0}
      >
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-border/40 last:border-0">
            <td className="px-4 py-3">
              {rejectable.some((x) => x.id === r.id) ? (
                <input type="checkbox" aria-label="Selecionar" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
              ) : null}
            </td>
            <td className="max-w-md px-4 py-3">
              <p className="line-clamp-2 text-xs">{r.title ?? r.sourceUrl}</p>
              <p className="font-mono text-[11px] text-muted-foreground">
                {r.celex ?? "—"} · {r.jurisdictionHint ?? "—"}
              </p>
            </td>
            <td className="px-4 py-3 text-xs text-muted-foreground">
              {r.docType ? DOC_TYPE_LABELS[r.docType] : "—"}
              <br />
              {r.date ?? r.collectedAt.slice(0, 10)}
            </td>
            <td className="px-4 py-3 text-xs text-muted-foreground">{r.domain ?? "—"}</td>
            <td className="px-4 py-3">
              <StatusBadge label={TRIAGE_LABELS[r.state]} tone={STATE_TONE[r.state]} />
            </td>
            <td className="px-4 py-3 text-[11px] text-muted-foreground">
              {r.curation?.applies_to_jurisdictions.join(", ") || "—"}
              {r.curation?.application_status ? <br /> : null}
              {r.curation?.application_status ? APPLICATION_LABELS[r.curation.application_status] : null}
            </td>
            <td className="px-4 py-3">
              <GlowButton variant="ghost" aria-label="Abrir triagem" onClick={() => setDetailId(r.id)}>
                <Eye className="h-4 w-4" />
              </GlowButton>
            </td>
          </tr>
        ))}
      </DataTable>

      <CurationDialog id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

function CurationDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const fetchDetail = useServerFn(getItemDetail);
  const save = useServerFn(saveItemCuration);
  const reject = useServerFn(rejectItems);
  const review = useServerFn(setItemReviewState);
  const detail = useQuery({
    queryKey: ["item-detail", id],
    queryFn: () => fetchDetail({ data: { normalizedItemId: id! } }),
    enabled: !!id,
  });
  const d = detail.data;
  const [juris, setJuris] = useState<string[]>([]);
  const [app, setApp] = useState<ApplicationStatus | "">("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [showPayload, setShowPayload] = useState(false);

  useEffect(() => {
    setJuris(d?.curation?.applies_to_jurisdictions ?? []);
    setApp(d?.curation?.application_status ?? "");
    setNote(d?.curation?.reviewer_note ?? "");
    setReason("");
  }, [d?.id, d?.curation?.curated_at]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["triage"] });
    qc.invalidateQueries({ queryKey: ["tier-matrix"] });
    qc.invalidateQueries({ queryKey: ["item-detail", id] });
  };
  const run = useMutation({
    mutationFn: async (kind: "save" | "approve" | "reject" | "reopen" | "internal") => {
      if (!id) return;
      if (kind === "reject") return reject({ data: { normalizedItemIds: [id], reason } });
      if (kind === "reopen") return review({ data: { normalizedItemId: id, action: "reopen" } });
      if (kind === "internal") return review({ data: { normalizedItemId: id, action: "set_internal_only" } });
      return save({
        data: {
          normalizedItemId: id,
          appliesTo: juris,
          applicationStatus: app || null,
          reviewerNote: note,
          approve: kind === "approve",
        },
      });
    },
    onSuccess: (res, kind) => {
      if (res && "failed" in res && res.failed.length) {
        toast.error(res.failed[0]?.error ?? "Falha");
        return;
      }
      toast.success(
        { save: "Escopo salvo.", approve: "Aprovado para Exchange.", reject: "Item rejeitado.", reopen: "Item reaberto.", internal: "Voltou para interno." }[kind],
      );
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejected = d?.verificationStatus === "rejected";
  const eligible = d?.publicationStatus === "eligible";
  const canApprove = juris.length > 0 && !!app;

  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="glass-panel max-h-[90vh] w-full max-w-3xl overflow-y-auto border-glass-border p-0">
        {detail.isLoading || !d ? (
          <div className="p-6 text-sm text-muted-foreground">
            {detail.error ? (detail.error as Error).message : "Carregando…"}
          </div>
        ) : (
          <>
            <DialogHeader className="border-b border-border/40 p-6 pb-4 text-left">
              <DialogTitle className="glow-text text-lg font-semibold">{d.title ?? "Sem título"}</DialogTitle>
              <DialogDescription asChild>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-mono">{d.celex ?? "—"}</span>
                  <span>{d.docType ? DOC_TYPE_LABELS[d.docType] : "—"}</span>
                  <span>{d.documentDate ?? "—"}</span>
                  <span>Jurisdição: {d.jurisdictionHint ?? "—"}</span>
                  <span>{d.verificationStatus} / {d.publicationStatus}</span>
                </div>
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-5 p-6 pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={d.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="glow-btn glow-btn--ghost inline-flex items-center gap-2 text-sm"
                >
                  <ExternalLink className="h-4 w-4" /> Abrir fonte oficial
                </a>
                <span className="max-w-md truncate text-xs text-muted-foreground">{d.sourceUrl}</span>
              </div>
              {d.eurovoc.length ? (
                <p className="text-xs text-muted-foreground">EuroVoc: {d.eurovoc.join(", ")}</p>
              ) : null}

              {rejected ? (
                <div className="space-y-2">
                  <p className="text-sm">Rejeitado{d.curation?.reject_reason ? `: ${d.curation.reject_reason}` : ""}.</p>
                  <GlowButton variant="ghost" disabled={run.isPending} onClick={() => run.mutate("reopen")}>
                    Reabrir para revisão
                  </GlowButton>
                </div>
              ) : (
                <>
                  <div>
                    <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                      Jurisdições afetadas
                    </span>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {COVERED_JURISDICTIONS.map((j) => (
                        <label key={j} className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs">
                          <input
                            type="checkbox"
                            disabled={eligible}
                            checked={juris.includes(j)}
                            onChange={() =>
                              setJuris((p) => (p.includes(j) ? p.filter((x) => x !== j) : [...p, j]))
                            }
                          />
                          {j}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Estado de aplicação">
                      <select
                        className={inputClass}
                        disabled={eligible}
                        value={app}
                        onChange={(e) => setApp(e.target.value as ApplicationStatus | "")}
                      >
                        <option value="">— escolher —</option>
                        {APPLICATION_STATUSES.map((a) => (
                          <option key={a} value={a}>{APPLICATION_LABELS[a]}</option>
                        ))}
                      </select>
                    </Field>
                    <div className="flex items-end">
                      <GlowButton
                        variant="ghost"
                        disabled={eligible}
                        onClick={() => setApp("implementation_to_verify")}
                      >
                        Precisa de implementação nacional
                      </GlowButton>
                    </div>
                  </div>
                  <Field label="Nota editorial">
                    <textarea
                      className={`${inputClass} min-h-20`}
                      disabled={eligible}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </Field>
                  {eligible ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm">Aprovado para Exchange. Envie pela tela Exchange handoff.</p>
                      <GlowButton variant="ghost" disabled={run.isPending} onClick={() => run.mutate("internal")}>
                        Voltar para interno (editar escopo)
                      </GlowButton>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <GlowButton variant="ghost" disabled={run.isPending} onClick={() => run.mutate("save")}>
                        Salvar escopo
                      </GlowButton>
                      <GlowButton
                        variant="ghost"
                        disabled={run.isPending || !canApprove}
                        title={canApprove ? undefined : "Escolha jurisdições e estado de aplicação"}
                        onClick={() => run.mutate("approve")}
                      >
                        Aprovar para Exchange
                      </GlowButton>
                    </div>
                  )}
                  {!eligible ? (
                    <div className="flex flex-wrap items-end gap-2 border-t border-border/40 pt-4">
                      <input
                        className={`${inputClass} min-w-64 flex-1`}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Motivo (irrelevante, duplicado, fora de escopo…)"
                      />
                      <GlowButton
                        variant="ghost"
                        disabled={run.isPending || !reason.trim()}
                        onClick={() => run.mutate("reject")}
                      >
                        Rejeitar
                      </GlowButton>
                    </div>
                  ) : null}
                </>
              )}

              <div>
                <button className="text-xs text-muted-foreground underline" onClick={() => setShowPayload((v) => !v)}>
                  {showPayload ? "Ocultar payload" : "Ver payload"}
                </button>
                {showPayload ? (
                  <pre className="mt-2 max-h-64 overflow-auto rounded border border-border/40 p-3 font-mono text-[11px]">
                    {d.payloadJson}
                  </pre>
                ) : null}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
