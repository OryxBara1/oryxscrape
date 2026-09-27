import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { DataTable, GlowButton, ScreenHeader, StatusBadge } from "@/components/data-ui";
import { listLegacyDomains, runLegacyPromotion } from "@/lib/legacy.functions";

export const Route = createFileRoute("/_authenticated/admin/legacy-audit")({
  head: () => ({
    meta: [
      { title: "Legacy audit — OryxScrape" },
      { name: "description", content: "Provenance check and normalization of legacy raw items, per domain." },
      { property: "og:title", content: "Legacy audit — OryxScrape" },
      { property: "og:description", content: "Domain-by-domain promotion of legacy raw items." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: LegacyAuditScreen,
});

function LegacyAuditScreen() {
  const queryClient = useQueryClient();
  const fetchDomains = useServerFn(listLegacyDomains);
  const runPromotion = useServerFn(runLegacyPromotion);

  const domains = useQuery({ queryKey: ["legacy-domains"], queryFn: () => fetchDomains() });

  const promote = useMutation({
    mutationFn: (domain: string) => runPromotion({ data: { domain } }),
    onSuccess: (res) => {
      toast.success(
        `${res.domain}: ${res.checked} verificados · ${res.passed} íntegros · ${res.normalized} normalizados · ${res.provenanceFailed + res.normalizationFailed} falhas. Auditoria gravada.`,
      );
      queryClient.invalidateQueries({ queryKey: ["legacy-domains"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = domains.data ?? [];

  return (
    <section className="space-y-6">
      <ScreenHeader
        title="Legacy audit"
        description="Itens legados (sem status) entram na revisão só depois de checagem de proveniência e normalização, domínio por domínio. Os itens brutos nunca são alterados; cada lote grava um registro de auditoria."
      />

      {domains.error ? (
        <div className="glass-panel p-5 text-sm text-rose-300">{(domains.error as Error).message}</div>
      ) : null}

      <DataTable
        headers={["Domain", "Legacy items", "Normalized", "Gap", "Action"]}
        loading={domains.isLoading}
        empty={!domains.isLoading && rows.length === 0}
      >
        {rows.map((row) => (
          <tr key={row.domain} className="border-b border-border/40 last:border-0">
            <td className="px-4 py-3 text-sm">{row.domain}</td>
            <td className="px-4 py-3 font-mono text-xs">{row.total}</td>
            <td className="px-4 py-3 font-mono text-xs">{row.normalized}</td>
            <td className="px-4 py-3">
              <StatusBadge
                label={row.gap === 0 ? "complete" : `${row.gap} pending`}
                tone={row.gap === 0 ? "ok" : "warn"}
              />
            </td>
            <td className="px-4 py-3">
              <GlowButton
                disabled={promote.isPending || row.gap === 0}
                onClick={() => promote.mutate(row.domain)}
              >
                {promote.isPending ? "Running…" : "Run provenance check + normalize"}
              </GlowButton>
            </td>
          </tr>
        ))}
      </DataTable>
    </section>
  );
}
