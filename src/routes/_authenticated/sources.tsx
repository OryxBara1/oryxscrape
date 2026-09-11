import { createFileRoute } from "@tanstack/react-router";

import { ScreenPlaceholder } from "@/components/app-shell";

export const Route = createFileRoute("/_authenticated/sources")({
  head: () => ({
    meta: [
      { title: "Sources — OryxScrape" },
      {
        name: "description",
        content: "Manage scrape targets, terms-of-service and robots status, and objective facts.",
      },
      { property: "og:title", content: "Sources — OryxScrape" },
      {
        property: "og:description",
        content: "Scrape targets with compliance status and provenance facts.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: () => (
    <ScreenPlaceholder
      title="Sources"
      description="Scrape targets, ToS and robots.txt status, and the four objective provenance facts."
    />
  ),
});
