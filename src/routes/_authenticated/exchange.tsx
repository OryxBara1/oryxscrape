import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Archive, Pencil } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  DataTable,
  Field,
  GlowButton,
  ScreenHeader,
  StatusBadge,
  formatDate,
  inputClass,
} from "@/components/data-ui";
import {
  listHandoffCandidates,
  listHandoffs,
  listSuppressions,
  markHandoffProcessed,
  packageAndSendHandoff,
  syncExchangeFeedback,
  updateHandoffLocale,
} from "@/lib/exchange.functions";

const STATE_TONE: Record<string, string> = {
  pending: "neutral",
  archived: "ok",
  feedback_received: "warn",
  accepted: "live",
  rejected: "bad",
  error: "bad",
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "pending", label: "Awaiting" },
  { key: "archived", label: "Processed" },
  { key: "decided", label: "Decided" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];


export const Route = createFileRoute("/_authenticated/exchange")({
  head: () => ({
    meta: [
      { title: "Exchange handoff — OryxScrape" },
      {
        name: "description",
        content:
          "Package reviewed items as text artifacts and hand them to the AuraMaris shared Drive folder.",
      },
      { property: "og:title", content: "Exchange handoff — OryxScrape" },
      {
        property: "og:description",
        content: "Human-gated document handoff to the AuraMaris exchange Drive.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: ExchangeScreen,
});

function ExchangeScreen() {
  const queryClient = useQueryClient();
  const fetchCandidates = useServerFn(listHandoffCandidates);
  const fetchHandoffs = useServerFn(listHandoffs);
  const fetchSuppressions = useServerFn(listSuppressions);
  const sendHandoff = useServerFn(packageAndSendHandoff);
  const syncFeedback = useServerFn(syncExchangeFeedback);
  const correctLocale = useServerFn(updateHandoffLocale);
  const archiveHandoff = useServerFn(markHandoffProcessed);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [country, setCountry] = useState("");
  const [language, setLanguage] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCountry, setEditCountry] = useState("");
  const [editLanguage, setEditLanguage] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");


  const candidates = useQuery({
    queryKey: ["handoff-candidates"],
    queryFn: () => fetchCandidates(),
  });
  const handoffs = useQuery({ queryKey: ["handoffs"], queryFn: () => fetchHandoffs() });
  const suppressions = useQuery({
    queryKey: ["suppressions"],
    queryFn: () => fetchSuppressions(),
  });

  const send = useMutation({
    mutationFn: (vars: { normalizedItemId: string; countryCode: string; languageCode: string }) =>
      sendHandoff({ data: vars }),
    onSuccess: (res) => {
      toast.success(`Sent to 01_Pending_Review (${res.exchangeItemId}).`);
      setSelectedId(null);
      setCountry("");
      setLanguage("");
      queryClient.invalidateQueries({ queryKey: ["handoffs"] });
      queryClient.invalidateQueries({ queryKey: ["handoff-candidates"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const sync = useMutation({
    mutationFn: () => syncFeedback(),
    onSuccess: (res) =>
      toast.success(
        `Feedback synced: ${res.processed} processed, ${res.failed} failed, ${res.skipped} already handled.`,
      ),
    onError: (err: Error) => toast.error(err.message),
  });

  const correct = useMutation({
    mutationFn: (vars: { handoffId: string; countryCode: string; languageCode: string }) =>
      correctLocale({ data: vars }),
    onSuccess: (res) => {
      toast.success(
        `Corrected ${res.previous.country_code ?? "—"}/${res.previous.language_code ?? "—"} → ${res.next.country_code}/${res.next.language_code} and rewrote metadata.json.`,
      );
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey: ["handoffs"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const archive = useMutation({
    mutationFn: (vars: { handoffId: string }) => archiveHandoff({ data: vars }),
    onSuccess: (res) => {
      toast.success(`Marked as processed and moved to _processed (${res.exchangeItemId}).`);
      queryClient.invalidateQueries({ queryKey: ["handoffs"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });


  const canSend =
    !!selectedId && /^[A-Za-z]{2}$/.test(country) && /^[A-Za-z]{2}$/.test(language);
  const canCorrect =
    /^[A-Za-z]{2}$/.test(editCountry) && /^[A-Za-z]{2}$/.test(editLanguage);

  const allHandoffs = handoffs.data ?? [];
  const counts = {
    all: allHandoffs.length,
    pending: allHandoffs.filter((r) => r.state === "pending").length,
    archived: allHandoffs.filter((r) => r.state === "archived").length,
    decided: allHandoffs.filter(
      (r) => r.state !== "pending" && r.state !== "archived" && r.state !== "error",
    ).length,
  };
  const visibleHandoffs = allHandoffs.filter((r) => {
    if (filter === "all") return true;
    if (filter === "pending") return r.state === "pending";
    if (filter === "archived") return r.state === "archived";
    return r.state !== "pending" && r.state !== "archived" && r.state !== "error";
  });


  // Each source publishes for one jurisdiction, so selecting an item pre-fills
  // the codes; staff still confirms or overrides before sending.
  function selectCandidate(id: string | null) {
    setSelectedId(id);
    const candidate = (candidates.data ?? []).find((c) => c.id === id);
    setCountry(candidate?.suggestedCountryCode ?? "");
    setLanguage(candidate?.suggestedLanguageCode ?? "");
  }

  return (
    <section className="space-y-6">
      <ScreenHeader
        title="Exchange handoff"
        description="Reviewed items marked eligible for external handoff are packaged as extracted-text artifacts and copied to the AuraMaris shared Drive. Drive presence is not acceptance."
      />

      <div className="glass-panel space-y-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Send a candidate</h2>
          <GlowButton disabled={sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? "Syncing…" : "Sync exchange feedback"}
          </GlowButton>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Candidate item">
            <select
              className={inputClass}
              value={selectedId ?? ""}
              onChange={(e) => selectCandidate(e.target.value || null)}
            >
              <option value="">Select a reviewed + eligible item…</option>
              {(candidates.data ?? [])
                .filter((c) => !c.alreadySent)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title ?? c.sourceUrl}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Country code (confirm)">
            <input
              className={inputClass}
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="FR"
              maxLength={2}
            />
          </Field>
          <Field label="Language code (confirm)">
            <input
              className={inputClass}
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="fr"
              maxLength={2}
            />
          </Field>
        </div>

        <GlowButton
          disabled={!canSend || send.isPending}
          onClick={() =>
            selectedId &&
            send.mutate({
              normalizedItemId: selectedId,
              countryCode: country,
              languageCode: language,
            })
          }
        >
          {send.isPending ? "Packaging…" : "Package and send to 01_Pending_Review"}
        </GlowButton>
        {candidates.data && candidates.data.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No item is currently reviewed and eligible for external handoff.
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-md border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] transition ${
              filter === f.key
                ? "border-primary/60 text-foreground shadow-glow"
                : "border-border/60 bg-black/20 text-muted-foreground hover:border-primary/40 hover:text-foreground"
            }`}
          >
            {f.label} ({counts[f.key]})
          </button>
        ))}
      </div>

      <DataTable
        headers={[
          "Exchange item",
          "State",
          "Artifact",
          "Country / language",
          "Sent",
          "Processed",
          "Drive",
        ]}
        empty={!handoffs.isLoading && visibleHandoffs.length === 0}
      >
        {visibleHandoffs.map((row) => (

          <tr key={row.id} className="border-b border-border/40 last:border-0">
            <td className="px-4 py-3 font-mono text-[11px]">{row.exchange_item_id}</td>
            <td className="px-4 py-3">
              <StatusBadge label={row.state} tone={STATE_TONE[row.state] ?? "neutral"} />
              {row.error_reason ? (
                <p className="mt-1 max-w-72 text-[11px] text-rose-300">{row.error_reason}</p>
              ) : null}
              {row.reason_code ? (
                <p className="mt-1 text-[11px] text-muted-foreground">{row.reason_code}</p>
              ) : null}
            </td>
            <td className="px-4 py-3 text-[11px] text-muted-foreground">
              {row.artifact_filename} · {row.artifact_size_bytes} B
              <p className="max-w-60 truncate font-mono">{row.artifact_sha256}</p>
            </td>
            <td className="px-4 py-3 text-xs text-muted-foreground">
              {editingId === row.id ? (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className={`${inputClass} w-16 py-1 text-xs`}
                    value={editCountry}
                    maxLength={2}
                    onChange={(e) => setEditCountry(e.target.value)}
                  />
                  <input
                    className={`${inputClass} w-16 py-1 text-xs`}
                    value={editLanguage}
                    maxLength={2}
                    onChange={(e) => setEditLanguage(e.target.value)}
                  />
                  <GlowButton
                    type="submit"
                    disabled={!canCorrect || correct.isPending}
                    onClick={() =>
                      correct.mutate({
                        handoffId: row.id,
                        countryCode: editCountry,
                        languageCode: editLanguage,
                      })
                    }
                  >
                    {correct.isPending ? "Saving…" : "Save"}
                  </GlowButton>
                  <GlowButton variant="ghost" onClick={() => setEditingId(null)}>
                    Cancel
                  </GlowButton>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <span>
                    {row.country_code ?? "—"} / {row.language_code ?? "—"}
                  </span>
                  {row.state === "pending" ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-black/20 px-2 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground outline-none transition hover:border-primary/50 hover:text-foreground focus-visible:border-primary/50 focus-visible:shadow-glow"
                      onClick={() => {
                        setEditingId(row.id);
                        setEditCountry(row.country_code ?? "");
                        setEditLanguage(row.language_code ?? "");
                      }}
                    >
                      <Pencil size={11} strokeWidth={2} />
                      Edit locale
                    </button>
                  ) : null}
                </div>
              )}
            </td>
            <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(row.sent_at)}</td>
            <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">
              {row.drive_folder_id ?? "—"}
            </td>
          </tr>
        ))}
      </DataTable>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold">Suppressions</h2>
        <DataTable
          headers={["Rule", "Match", "Strength", "Reason", "Active", "Created"]}
          empty={!suppressions.isLoading && (suppressions.data ?? []).length === 0}
        >
          {(suppressions.data ?? []).map((row) => (
            <tr key={row.id} className="border-b border-border/40 last:border-0">
              <td className="px-4 py-3 text-xs">{row.rule_kind}</td>
              <td className="px-4 py-3 max-w-72 truncate font-mono text-[11px]">
                {row.match_value}
              </td>
              <td className="px-4 py-3">
                <StatusBadge
                  label={row.strength}
                  tone={row.strength === "hard_skip" ? "bad" : "warn"}
                />
              </td>
              <td className="px-4 py-3 text-[11px] text-muted-foreground">
                {row.reason_code ?? "—"}
              </td>
              <td className="px-4 py-3 text-xs">{row.is_active ? "yes" : "no"}</td>
              <td className="px-4 py-3 text-xs text-muted-foreground">
                {formatDate(row.created_at)}
              </td>
            </tr>
          ))}
        </DataTable>
      </div>
    </section>
  );
}
