import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { ScreenHeader, StatusBadge, formatDate } from "@/components/data-ui";
import { GlareCard } from "@/components/ui/glare-cards";
import { GlowingCard } from "@/components/ui/glowing-card";
import { getDashboardMetrics } from "@/lib/dashboard.functions";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — OryxScrape" },
      {
        name: "description",
        content: "Collection health at a glance: active sources, running jobs, items and audits.",
      },
      { property: "og:title", content: "Dashboard — OryxScrape" },
      {
        property: "og:description",
        content: "Collection health at a glance for the OryxBara data pipeline.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: DashboardScreen,
});

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <GlareCard className="rounded-xl">
      <GlowingCard value={value} label={label} />
      {hint ? <p className="px-1 pt-2 text-xs text-muted-foreground">{hint}</p> : null}
    </GlareCard>
  );
}

function DashboardScreen() {
  const fetchMetrics = useServerFn(getDashboardMetrics);
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard-metrics"],
    queryFn: () => fetchMetrics(),
  });

  return (
    <section className="space-y-6">
      <ScreenHeader
        title="Dashboard"
        description="Active sources, running jobs, items collected this week and the last audit."
      />

      {error ? (
        <div className="glass-panel p-5 text-sm text-rose-300">{(error as Error).message}</div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Active sources" value={isLoading ? "…" : (data?.activeSources ?? 0)} />
        <MetricCard label="Running jobs" value={isLoading ? "…" : (data?.runningJobs ?? 0)} />
        <MetricCard
          label="Items · last 7 days"
          value={isLoading ? "…" : (data?.itemsLast7Days ?? 0)}
          hint="Normalized items by collection date"
        />
        <div className="glass-panel p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
            Last audit event
          </p>
          {isLoading ? (
            <p className="mt-3 text-sm text-muted-foreground">…</p>
          ) : data?.lastAudit ? (
            <div className="mt-3 space-y-2">
              <p className="text-sm font-medium">{data.lastAudit.check_type}</p>
              <StatusBadge
                label={data.lastAudit.result}
                tone={data.lastAudit.result === "ok" ? "ok" : "warn"}
              />
              <p className="text-xs text-muted-foreground">{formatDate(data.lastAudit.run_at)}</p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">No audit runs recorded yet.</p>
          )}
        </div>
      </div>
    </section>
  );
}
