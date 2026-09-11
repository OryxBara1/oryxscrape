import { createFileRoute } from "@tanstack/react-router";

import { ScreenPlaceholder } from "@/components/app-shell";

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
  component: () => (
    <ScreenPlaceholder
      title="Collection jobs"
      description="Queued, running, succeeded, failed and cancelled runs with their counters."
    />
  ),
});
