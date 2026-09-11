import { createFileRoute } from "@tanstack/react-router";

import { ScreenPlaceholder } from "@/components/app-shell";

export const Route = createFileRoute("/_authenticated/audit")({
  head: () => ({
    meta: [
      { title: "Audit log — OryxScrape" },
      {
        name: "description",
        content:
          "History of duplicate, consistency, tier-drift and compliance re-check runs.",
      },
      { property: "og:title", content: "Audit log — OryxScrape" },
      {
        property: "og:description",
        content: "Duplicate, consistency and compliance check history for collected data.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: () => (
    <ScreenPlaceholder
      title="Audit log"
      description="Duplicate, consistency, tier-drift, ToS and robots re-check history."
    />
  ),
});
