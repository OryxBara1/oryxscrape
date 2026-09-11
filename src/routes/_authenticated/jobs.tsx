import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { DataTable, ScreenHeader, StatusBadge, formatDate } from "@/components/data-ui";
import { listCollectionJobs } from "@/lib/jobs.functions";

export const Route = createFileRoute("/_authenticated/jobs")({
  head: () => ({
    meta: [
      { title: "Collection jobs — OryxScrape" },
      {
        name: "description",
        content: "Live monitor of queued, running, finished and failed collection jobs.",
      },
      { property: "og:title", content: "Collection jobs — OryxScrape" },
      {
        property: "og:description",
        content: "Live status of the OryxScrape collection pipeline runs.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: JobsScreen,
});

const STATUS_TONE: Record<string, string> = {
  queued: "neutral",
  running: "live",
  succeeded: "ok",
  failed: "bad",
  cancelled: "warn",
};

function JobsScreen() {
  const fetchJobs = useServerFn(listCollectionJobs);
  const { data, isLoading, error } = useQuery({
    queryKey: ["collection-jobs"],
    queryFn: () => fetchJobs(),
  });

  const rows = data ?? [];

  return (
    <section className="space-y-6">
      <ScreenHeader
        title="Collection jobs"
        description="Queued, running, succeeded, failed and cancelled runs with their counters. Read-only until the Apify pipeline lands."
      />

      {error ? (
        <div className="glass-panel p-5 text-sm text-rose-300">{(error as Error).message}</div>
      ) : null}

      <DataTable
        headers={[
          "Source",
          "Profile",
          "Status",
          "Fetched",
          "New",
          "Dupes",
          "Failed",
          "Started",
          "Finished",
        ]}
        empty={!isLoading && rows.length === 0}
      >
        {rows.map((job) => (
          <tr key={job.id} className="border-b border-border/40 last:border-0">
            <td className="px-4 py-3">
              <p className="font-medium">{job.sources?.name ?? "—"}</p>
              <p className="text-xs text-muted-foreground">{job.sources?.domain ?? ""}</p>
            </td>
            <td className="px-4 py-3 text-xs text-muted-foreground">
              {job.research_profiles?.slug ?? "—"}
            </td>
            <td className="px-4 py-3">
              <StatusBadge label={job.status} tone={STATUS_TONE[job.status] ?? "neutral"} />
              {job.error_text ? (
                <p className="mt-1 max-w-56 truncate text-xs text-rose-300">{job.error_text}</p>
              ) : null}
            </td>
            <td className="px-4 py-3 font-mono text-xs">{job.fetched_count}</td>
            <td className="px-4 py-3 font-mono text-xs">{job.new_count}</td>
            <td className="px-4 py-3 font-mono text-xs">{job.duplicate_count}</td>
            <td className="px-4 py-3 font-mono text-xs">{job.failed_count}</td>
            <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(job.started_at)}</td>
            <td className="px-4 py-3 text-xs text-muted-foreground">
              {formatDate(job.finished_at)}
            </td>
          </tr>
        ))}
      </DataTable>
    </section>
  );
}
