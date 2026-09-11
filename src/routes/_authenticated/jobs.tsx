import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, GlowButton, ScreenHeader, StatusBadge, formatDate } from "@/components/data-ui";
import { listCollectionJobs } from "@/lib/jobs.functions";
import { listSources } from "@/lib/sources.functions";
import {
  normalizeCollectionJob,
  startCollectionJob,
  syncCollectionJob,
} from "@/lib/collection.functions";


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
  const queryClient = useQueryClient();
  const fetchJobs = useServerFn(listCollectionJobs);
  const fetchSources = useServerFn(listSources);
  const startJob = useServerFn(startCollectionJob);
  const syncJob = useServerFn(syncCollectionJob);
  const normalizeJob = useServerFn(normalizeCollectionJob);

  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["collection-jobs"],
    queryFn: () => fetchJobs(),
    refetchInterval: 15000,
  });
  const { data: sources } = useQuery({
    queryKey: ["sources"],
    queryFn: () => fetchSources(),
  });

  const rows = data ?? [];
  const activeSources = (sources ?? []).filter((source) => source.is_active);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["collection-jobs"] });

  const run = async (label: string, action: () => Promise<unknown>, key: string) => {
    setBusy(key);
    try {
      await action();
      toast.success(label);
      await refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-6">
      <ScreenHeader
        title="Collection jobs"
        description="Manual runs only in this phase: start an Apify crawl, sync it into raw items, then normalize with LogoriOn."
      />

      <div className="glass-panel flex flex-wrap items-center gap-3 p-5">
        <select
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
          className="h-10 min-w-64 rounded-md border border-border/60 bg-background/60 px-3 text-sm"
        >
          <option value="">Select a source…</option>
          {activeSources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
        <GlowButton
          disabled={!sourceId || busy === "start"}
          onClick={() =>
            run("Collection started", () => startJob({ data: { sourceId } }), "start")
          }
        >
          {busy === "start" ? "Starting…" : "Run collection"}
        </GlowButton>
      </div>

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
          "Actions",
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
            <td className="px-4 py-3">
              <div className="flex gap-2">
                <GlowButton
                  variant="ghost"
                  disabled={busy === `sync-${job.id}` || !job.apify_run_id}
                  onClick={() =>
                    run(
                      "Run synced",
                      () => syncJob({ data: { jobId: job.id } }),
                      `sync-${job.id}`,
                    )
                  }
                >
                  {busy === `sync-${job.id}` ? "Syncing…" : "Sync"}
                </GlowButton>
                <GlowButton
                  variant="ghost"
                  disabled={busy === `norm-${job.id}`}
                  onClick={() =>
                    run(
                      "Normalization finished",
                      () => normalizeJob({ data: { jobId: job.id } }),
                      `norm-${job.id}`,
                    )
                  }
                >
                  {busy === `norm-${job.id}` ? "Normalizing…" : "Normalize"}
                </GlowButton>
              </div>
            </td>
          </tr>
        ))}
      </DataTable>

    </section>
  );
}
