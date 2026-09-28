import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ExternalLink, SkipForward } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { GlowButton, ScreenHeader, StatusBadge, formatDate, inputClass } from "@/components/data-ui";
import { getItemDetail, rejectItems, setItemReviewState } from "@/lib/items.functions";
import { askCapy, countReviewByJurisdiction, listReviewQueue } from "@/lib/review.functions";

const REJECT_REASONS = [
  "Fora de escopo (não é náutica de recreio)",
  "Documento duplicado",
  "Sem relevância regulatória",
  "Fonte não oficial / baixa confiança",
  "Conteúdo ilegível ou incompleto",
];

const LAST_KEY = "oryx.review.lastId";
const SKIPPED_KEY = "oryx.review.skipped";

function readSkipped(): Set<string> {
  try {
    const raw = localStorage.getItem(SKIPPED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export const Route = createFileRoute("/_authenticated/review")({
  head: () => ({
    meta: [
      { title: "Guided review — OryxScrape" },
      { name: "description", content: "One item at a time: approve, reject or skip." },
      { property: "og:title", content: "Guided review — OryxScrape" },
      { property: "og:description", content: "Guided triage queue for collected documents." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: ReviewScreen,
});

function ReviewScreen() {
  const queryClient = useQueryClient();
  const fetchQueue = useServerFn(listReviewQueue);
  const fetchCounts = useServerFn(countReviewByJurisdiction);
  const fetchDetail = useServerFn(getItemDetail);
  const applyState = useServerFn(setItemReviewState);
  const applyReject = useServerFn(rejectItems);

  const [jurisdiction, setJurisdiction] = useState("");
  const [domain, setDomain] = useState("");
  const [index, setIndex] = useState(0);
  const [skipped, setSkipped] = useState<Set<string>>(() => readSkipped());
  const [rejectReason, setRejectReason] = useState(REJECT_REASONS[0] ?? "");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [capyOpen, setCapyOpen] = useState(false);

  const queue = useQuery({
    queryKey: ["review-queue", jurisdiction, domain],
    queryFn: () => fetchQueue({ data: { jurisdiction: jurisdiction || null, domain: domain || null } }),
  });
  const counts = useQuery({
    queryKey: ["review-counts"],
    queryFn: () => fetchCounts(),
  });

  const items = useMemo(
    () => (queue.data ?? []).filter((i) => !skipped.has(i.id)),
    [queue.data, skipped],
  );
  const current = items[Math.min(index, Math.max(items.length - 1, 0))] ?? null;

  const detail = useQuery({
    queryKey: ["review-detail", current?.id],
    queryFn: () => fetchDetail({ data: { normalizedItemId: current!.id } }),
    enabled: !!current,
  });

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["review-queue"] });
    queryClient.invalidateQueries({ queryKey: ["review-counts"] });
  }, [queryClient]);

  const advance = useCallback(() => {
    setRejectOpen(false);
    setIndex((i) => i + 1);
  }, []);

  const approveEligible = useMutation({
    mutationFn: async (id: string) => {
      await applyState({ data: { normalizedItemId: id, action: "review" } });
      await applyState({ data: { normalizedItemId: id, action: "mark_eligible" } });
    },
    onSuccess: () => {
      toast.success("Approved for the AuraMaris queue.");
      refresh();
      advance();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const approveInternal = useMutation({
    mutationFn: (id: string) => applyState({ data: { normalizedItemId: id, action: "review" } }),
    onSuccess: () => {
      toast.success("Kept in OryxScrape (internal only).");
      refresh();
      advance();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reject = useMutation({
    mutationFn: (vars: { id: string; reason: string }) =>
      applyReject({ data: { normalizedItemIds: [vars.id], reason: vars.reason } }),
    onSuccess: (res) => {
      if (res.failed.length) {
        toast.error(res.failed[0]?.error ?? "Rejection failed.");
        return;
      }
      toast.success("Item rejected.");
      refresh();
      advance();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const skip = useCallback(() => {
    if (!current) return;
    setSkipped((prev) => {
      const next = new Set(prev);
      next.add(current.id);
      try {
        localStorage.setItem(SKIPPED_KEY, JSON.stringify(Array.from(next)));
      } catch {
        // storage full or unavailable — skip still works for this session
      }
      return next;
    });
  }, [current]);

  const openOriginal = useCallback(() => {
    if (current?.sourceUrl) window.open(current.sourceUrl, "_blank", "noopener,noreferrer");
  }, [current]);

  const busy = approveEligible.isPending || approveInternal.isPending || reject.isPending;

  // Keyboard shortcuts: A approve→AuraMaris, R reject, S skip, O open original.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      if (!current || busy) return;
      const key = e.key.toLowerCase();
      if (key === "a") approveEligible.mutate(current.id);
      else if (key === "r") setRejectOpen(true);
      else if (key === "s") skip();
      else if (key === "o") openOriginal();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, busy, approveEligible, skip, openOriginal]);

  // Restore last seen position once per queue load.
  useEffect(() => {
    if (!queue.data || index !== 0) return;
    try {
      const lastId = localStorage.getItem(LAST_KEY);
      if (!lastId) return;
      const pos = items.findIndex((i) => i.id === lastId);
      if (pos > 0) setIndex(pos);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.data]);

  useEffect(() => {
    if (!current) return;
    try {
      localStorage.setItem(LAST_KEY, current.id);
    } catch {
      // ignore
    }
  }, [current]);

  const domains = useMemo(
    () => Array.from(new Set((queue.data ?? []).map((i) => i.domain).filter((d): d is string => !!d))).sort(),
    [queue.data],
  );

  const total = items.length;
  const position = total ? Math.min(index + 1, total) : 0;

  return (
    <section className="space-y-6">
      <ScreenHeader
        title="Guided review"
        description="Um item por vez: aprove para a fila da AuraMaris, mantenha interno, rejeite ou pule. Atalhos: A aprovar · R rejeitar · S pular · O abrir original."
      />

      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <aside className="space-y-4">
          <div className="glass-panel p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              Pendentes por jurisdição
            </p>
            <div className="mt-3 space-y-1.5">
              <button
                type="button"
                onClick={() => {
                  setJurisdiction("");
                  setIndex(0);
                }}
                className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-sm transition ${
                  !jurisdiction ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span>Todas</span>
                <span className="font-mono text-xs">
                  {(counts.data ?? []).reduce((acc, c) => acc + c.count, 0)}
                </span>
              </button>
              {(counts.data ?? []).map((c) => (
                <button
                  key={c.jurisdiction}
                  type="button"
                  onClick={() => {
                    setJurisdiction(c.jurisdiction === "—" ? "" : c.jurisdiction);
                    setIndex(0);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-sm transition ${
                    jurisdiction === c.jurisdiction
                      ? "bg-primary/15 text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span>{c.jurisdiction}</span>
                  <span className="font-mono text-xs">{c.count}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="glass-panel p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Fonte</p>
            <select
              className={`${inputClass} mt-2 w-full`}
              value={domain}
              onChange={(e) => {
                setDomain(e.target.value);
                setIndex(0);
              }}
            >
              <option value="">Todas as fontes</option>
              {domains.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          <div className="glass-panel p-4">
            <button
              type="button"
              onClick={() => setCapyOpen((v) => !v)}
              className="flex w-full items-center justify-between text-sm text-muted-foreground transition hover:text-foreground"
            >
              <span>🦫 Capy</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.22em]">
                {capyOpen ? "ocultar" : "copiloto"}
              </span>
            </button>
            {capyOpen ? <CapyPanel itemId={current?.id ?? null} /> : null}
          </div>
        </aside>

        <div className="min-w-0">
          {queue.isLoading ? (
            <div className="glass-panel p-10 text-center text-sm text-muted-foreground">Carregando fila…</div>
          ) : queue.error ? (
            <div className="glass-panel p-5 text-sm text-rose-300">{(queue.error as Error).message}</div>
          ) : !current ? (
            <div className="glass-panel p-10 text-center">
              <p className="text-lg font-semibold">Fila vazia 🎉</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Nenhum item pendente neste recorte.
                {skipped.size > 0 ? (
                  <button
                    type="button"
                    className="ml-2 text-primary underline"
                    onClick={() => {
                      setSkipped(new Set());
                      setIndex(0);
                      try {
                        localStorage.removeItem(SKIPPED_KEY);
                      } catch {
                        // ignore
                      }
                    }}
                  >
                    Rever {skipped.size} pulados
                  </button>
                ) : null}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="font-mono text-xs text-muted-foreground">
                  {position} de {total}
                  {skipped.size > 0 ? ` · ${skipped.size} pulados` : ""}
                </p>
                <div className="flex gap-2">
                  <StatusBadge label={current.jurisdictionHint ?? "—"} tone="live" />
                  {current.docType ? <StatusBadge label={current.docType} tone="neutral" /> : null}
                  {current.domain ? <StatusBadge label={current.domain} tone="neutral" /> : null}
                </div>
              </div>

              <div className="glass-panel space-y-4 p-6">
                <div>
                  <h2 className="glow-text text-xl font-semibold tracking-tight">
                    {current.title ?? "Sem título"}
                  </h2>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <a
                      href={current.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="max-w-md truncate text-primary hover:underline"
                    >
                      {current.sourceUrl}
                    </a>
                    <GlowButton variant="ghost" aria-label="Open original" onClick={openOriginal}>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </GlowButton>
                    {current.celex ? <span>· CELEX {current.celex}</span> : null}
                    {current.date ? <span>· {current.date}</span> : null}
                    <span>· coletado {formatDate(current.collectedAt)}</span>
                  </div>
                  {current.tags.length ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {current.tags.map((t) => (
                        <span
                          key={t}
                          className="rounded-full border border-border/60 px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                    Prévia do texto
                  </p>
                  <div className="glass-panel mt-1 max-h-[38vh] overflow-auto rounded-lg border border-border/40 p-4">
                    {detail.isLoading ? (
                      <p className="text-sm text-muted-foreground">Carregando…</p>
                    ) : detail.data?.extractedText ? (
                      <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">
                        {detail.data.extractedText.slice(0, 2000)}
                        {detail.data.extractedText.length > 2000 ? "…" : ""}
                      </pre>
                    ) : (
                      <p className="text-sm italic text-muted-foreground">
                        Sem texto extraído — abra o original para avaliar.
                      </p>
                    )}
                  </div>
                </div>

                {detail.data?.curation?.reviewer_note ? (
                  <p className="text-xs text-muted-foreground">
                    Nota anterior: {detail.data.curation.reviewer_note}
                  </p>
                ) : null}

                {rejectOpen ? (
                  <div className="glass-panel space-y-3 border border-rose-500/30 p-4">
                    <p className="text-sm font-medium">Motivo da rejeição (obrigatório)</p>
                    <select
                      className={`${inputClass} w-full`}
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                    >
                      {REJECT_REASONS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                    <div className="flex gap-2">
                      <GlowButton
                        disabled={busy || !rejectReason}
                        onClick={() => reject.mutate({ id: current.id, reason: rejectReason })}
                      >
                        Confirmar rejeição
                      </GlowButton>
                      <GlowButton variant="ghost" onClick={() => setRejectOpen(false)}>
                        Cancelar
                      </GlowButton>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <GlowButton disabled={busy} onClick={() => approveEligible.mutate(current.id)}>
                      Aprovar → fila AuraMaris (A)
                    </GlowButton>
                    <GlowButton variant="ghost" disabled={busy} onClick={() => approveInternal.mutate(current.id)}>
                      Manter só no OryxScrape
                    </GlowButton>
                    <GlowButton variant="ghost" disabled={busy} onClick={() => setRejectOpen(true)}>
                      Rejeitar (R)
                    </GlowButton>
                    <GlowButton variant="ghost" disabled={busy} onClick={skip}>
                      <SkipForward className="mr-1 h-3.5 w-3.5" /> Pular (S)
                    </GlowButton>
                  </div>
                )}

                {current.jurisdictionHint === "EU" ? (
                  <p className="text-xs text-amber-300/90">
                    Item EU: a aprovação para a fila AuraMaris exige jurisdições afetadas e estado de
                    aplicação — defina o escopo na tela "Advanced Review" antes de aprovar.
                  </p>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

const CAPY_QUICK = [
  "Do que trata este documento?",
  "Qual o impacto para náutica e marinas?",
  "Quais jurisdições parecem afetadas?",
  "Por que este documento é (ou não) relevante?",
];

function CapyPanel({ itemId }: { itemId: string | null }) {
  const ask = useServerFn(askCapy);
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState<{ q: string; a: string }[]>([]);
  useEffect(() => setAnswers([]), [itemId]);
  const mutation = useMutation({
    mutationFn: (q: string) => ask({ data: { itemId: itemId!, question: q } }),
    // Newest answer first: the sidebar grows downward, so appending pushed new
    // answers off-screen and made follow-up questions look like they did nothing.
    onSuccess: (res, q) => {
      setAnswers((prev) => [{ q, a: res.answer }, ...prev]);
      setQuestion("");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!itemId) return <p className="mt-3 text-xs text-muted-foreground">Nenhum item em revisão.</p>;
  const send = (q: string) => q.trim() && !mutation.isPending && mutation.mutate(q.trim());
  return (
    <div className="mt-3 space-y-3 text-xs">
      <p className="text-muted-foreground">Copiloto consultivo: não aprova nem altera nada. Confira sempre na fonte.</p>
      <div className="flex flex-wrap gap-1.5">
        {CAPY_QUICK.map((q) => (
          <button
            key={q}
            type="button"
            disabled={mutation.isPending}
            onClick={() => send(q)}
            className="rounded-md border border-border px-2 py-1 text-left text-muted-foreground transition hover:text-foreground disabled:opacity-50"
          >
            {q}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(question);
        }}
        className="flex gap-2"
      >
        <input
          className={`${inputClass} min-w-0 flex-1`}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Pergunte ao Capy…"
        />
        <GlowButton
          type="submit"
          className="shrink-0"
          disabled={mutation.isPending || !question.trim()}
        >
          {mutation.isPending ? "…" : "Enviar"}
        </GlowButton>
      </form>
      {mutation.isPending ? (
        <p className="animate-pulse border-t border-border pt-2 text-muted-foreground">
          Capy está analisando o documento…
        </p>
      ) : null}
      {answers.length ? (
        <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
          {answers.map((x, i) => (
            <div key={`${i}-${x.q}`} className="space-y-1 border-t border-border pt-2">
              <p className="font-medium text-foreground">{x.q}</p>
              <p className="whitespace-pre-wrap text-muted-foreground">{x.a}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
