import { createFileRoute } from "@tanstack/react-router";

import { ScreenPlaceholder } from "@/components/app-shell";

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
  component: () => (
    <ScreenPlaceholder
      title="Dashboard"
      description="Active sources, running jobs, items collected this week and the last audit."
    />
  ),
});
