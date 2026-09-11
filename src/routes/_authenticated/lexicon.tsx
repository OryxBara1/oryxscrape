import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import {
  DataTable,
  GlowButton,
  ScreenHeader,
  StatusBadge,
  formatDate,
  inputClass,
} from "@/components/data-ui";
import {
  LIFECYCLE_STATES,
  exportSearchTerms,
  listSearchTerms,
  setSearchTermLifecycle,
  type SearchTermLifecycle,
} from "@/lib/search-terms.functions";

const TONE: Record<string, string> = {
  candidate: "neutral",
  promising: "warn",
  validated: "live",
  ambiguous: "warn",
  cooldown: "warn",
  disabled_auto: "bad",
  manual_only: "neutral",
  deprecated: "bad",
};

export const Route = createFileRoute("/_authenticated/lexicon")({
  head: () => ({
    meta: [
      { title: "Search lexicon — OryxScrape" },
      {
        name: "description",
        content:
          "Passive record of search terms per concept with attempt, usefulness and false-positive counts.",
      },
      { property: "og:title", content: "Search lexicon — OryxScrape" },
      {
        property: "og:description",
        content: "Query intelligence lexicon with human-set lifecycle states.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: LexiconScreen,
});

function LexiconScreen() {
  const queryClient = useQueryClient();
  const fetchTerms = useServerFn(listSearchTerms);
  const setLifecycle = useServerFn(setSearchTermLifecycle);
  const exportTerms = useServerFn(exportSearchTerms);

  const terms = useQuery({ queryKey: ["search-terms"], queryFn: () => fetchTerms() });

  const update = useMutation({
    mutationFn: (vars: { id: string; lifecycleState: SearchTermLifecycle }) =>
      setLifecycle({ data: vars }),
    onSuccess: () => {
      toast.success("Lifecycle state updated.");
      queryClient.invalidateQueries({ queryKey: ["search-terms"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const exportRun = useMutation({
    mutationFn: () => exportTerms(),
    onSuccess: (res) => toast.success(`Exported ${res.count} terms to 05_Search_Terms_Shared.`),
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <section className="space-y-6">
      <ScreenHeader
        title="Search lexicon"
        description="Passive query intelligence. Lifecycle states are set by hand and never suppress a search automatically."
      />

      <div className="flex justify-end">
        <GlowButton disabled={exportRun.isPending} onClick={() => exportRun.mutate()}>
          {exportRun.isPending ? "Exporting…" : "Export to shared Drive"}
        </GlowButton>
      </div>

      <DataTable
        headers={["Concept", "Term", "Scope", "Counts", "Lifecycle", "Last run"]}
        empty={!terms.isLoading && (terms.data ?? []).length === 0}
      >
        {(terms.data ?? []).map((row) => (
          <tr key={row.id} className="border-b border-border/40 last:border-0">
            <td className="px-4 py-3 text-xs">
              {row.concept_label}
              <p className="font-mono text-[11px] text-muted-foreground">{row.concept_code}</p>
            </td>
            <td className="px-4 py-3 max-w-72 text-xs">{row.term}</td>
            <td className="px-4 py-3 text-[11px] text-muted-foreground">
              {row.country_code ?? "—"} / {row.language_code ?? "—"}
              <p>{row.target_domain ?? "—"}</p>
            </td>
            <td className="px-4 py-3 text-[11px] text-muted-foreground">
              {row.attempt_count} tried · {row.useful_count} useful · {row.false_positive_count}{" "}
              false positive
            </td>
            <td className="px-4 py-3">
              <div className="flex flex-col items-start gap-2">
                <StatusBadge
                  label={row.lifecycle_state}
                  tone={TONE[row.lifecycle_state] ?? "neutral"}
                />
                <select
                  className={inputClass}
                  value={row.lifecycle_state}
                  disabled={update.isPending}
                  onChange={(e) =>
                    update.mutate({
                      id: row.id,
                      lifecycleState: e.target.value as SearchTermLifecycle,
                    })
                  }
                >
                  {LIFECYCLE_STATES.map((state) => (
                    <option key={state} value={state}>
                      {state}
                    </option>
                  ))}
                </select>
              </div>
            </td>
            <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(row.last_run_at)}</td>
          </tr>
        ))}
      </DataTable>
    </section>
  );
}
