import { createFileRoute } from "@tanstack/react-router";

import { ScreenPlaceholder } from "@/components/app-shell";

export const Route = createFileRoute("/_authenticated/items")({
  head: () => ({
    meta: [
      { title: "Collected items — OryxScrape" },
      {
        name: "description",
        content: "Browse raw and normalized items, filterable by jurisdiction, category and tier.",
      },
      { property: "og:title", content: "Collected items — OryxScrape" },
      {
        property: "og:description",
        content: "Raw versus normalized items with per-profile tier resolution.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: () => (
    <ScreenPlaceholder
      title="Collected items"
      description="Raw versus normalized items, filterable by jurisdiction, category and resolved tier."
    />
  ),
});
