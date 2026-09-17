import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
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
  packageAndSendHandoff,
  syncExchangeFeedback,
  updateHandoffLocale,
} from "@/lib/exchange.functions";

const STATE_TONE: Record<string, string> = {
  pending: "neutral",
  feedback_received: "warn",
  accepted: "live",
  rejected: "bad",
  error: "bad",
};

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

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [country, setCountry] = useState("");
  const [language, setLanguage] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCountry, setEditCountry] = useState("");
  const [editLanguage, setEditLanguage] = useState("");

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

  const canSend =
    !!selectedId && /^[A-Za-z]{2}$/.test(country) && /^[A-Za-z]{2}$/.test(language);
  const canCorrect =
    /^[A-Za-z]{2}$/.test(editCountry) && /^[A-Za-z]{2}$/.test(editLanguage);

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

      <DataTable
        headers={["Exchange item", "State", "Artifact", "Country / language", "Sent", "Drive"]}
        empty={!handoffs.isLoading && (handoffs.data ?? []).length === 0}
      >
        {(handoffs.data ?? []).map((row) => (
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
              {row.country_code ?? "—"} / {row.language_code ?? "—"}
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
