import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";

import {
  DataTable,
  Field,
  GlowButton,
  ScreenHeader,
  StatusBadge,
  formatDate,
  inputClass,
} from "@/components/data-ui";
import {
  allowedActionsFor,
  listResearchProfiles,
  listTierMatrix,
  setItemPromotion,
  setItemReviewState,
  type ReviewAction,
} from "@/lib/items.functions";
import type { Database } from "@/integrations/supabase/types";

type TierLabel = Database["public"]["Enums"]["tier_label"];
type VerificationStatus = Database["public"]["Enums"]["verification_status"];
type PublicationStatus = Database["public"]["Enums"]["publication_status"];
const TIERS: TierLabel[] = ["T1", "T2", "T3", "T4", "T5"];

const ACTION_LABELS: Record<ReviewAction, string> = {
  review: "Review",
  reject: "Reject",
  reopen: "Reopen for review",
  mark_eligible: "Mark eligible",
  set_internal_only: "Set internal only",
};

const VERIFICATION_TONE: Record<VerificationStatus, string> = {
  unreviewed: "neutral",
  reviewed: "ok",
  rejected: "bad",
};

const PUBLICATION_TONE: Record<PublicationStatus, string> = {
  internal_only: "neutral",
  eligible: "live",
};


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
  component: ItemsScreen,
});

function ItemsScreen() {
  const queryClient = useQueryClient();
  const fetchProfiles = useServerFn(listResearchProfiles);
  const fetchMatrix = useServerFn(listTierMatrix);
  const togglePromotion = useServerFn(setItemPromotion);

  const [profileId, setProfileId] = useState("");
  const [tier, setTier] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [category, setCategory] = useState("");

  const profiles = useQuery({
    queryKey: ["research-profiles"],
    queryFn: () => fetchProfiles(),
  });

  const filters = {
    profileId: profileId || null,
    tier: (tier || null) as TierLabel | null,
    jurisdiction: jurisdiction || null,
    category: category || null,
  };

  const matrix = useQuery({
    queryKey: ["tier-matrix", filters],
    queryFn: () => fetchMatrix({ data: filters }),
  });

  const promote = useMutation({
    mutationFn: (vars: { normalizedItemId: string; profileId: string; promoted: boolean }) =>
      togglePromotion({ data: vars }),
    onSuccess: (res) => {
      toast.success(res.promoted ? "Item promoted for this profile." : "Promotion removed.");
      queryClient.invalidateQueries({ queryKey: ["tier-matrix"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const rows = matrix.data ?? [];

  return (
    <section className="space-y-6">
      <ScreenHeader
        title="Collected items"
        description="Normalized items with the objective facts and how each active profile's policy classifies them."
      />

      <div className="glass-panel grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Profile">
          <select
            className={inputClass}
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
          >
            <option value="">All profiles</option>
            {(profiles.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.slug}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tier">
          <select className={inputClass} value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="">All tiers</option>
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Jurisdiction">
          <input
            className={inputClass}
            value={jurisdiction}
            onChange={(e) => setJurisdiction(e.target.value)}
            placeholder="EU"
          />
        </Field>
        <Field label="Category">
          <input
            className={inputClass}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="regulation"
          />
        </Field>
      </div>

      {matrix.error ? (
        <div className="glass-panel p-5 text-sm text-rose-300">
          {(matrix.error as Error).message}
        </div>
      ) : null}

      <DataTable
        headers={["Item", "Profile", "Tier", "Facts", "Promotion", "Updated"]}
        empty={!matrix.isLoading && rows.length === 0}
      >
        {rows.map((row) => (
          <tr
            key={`${row.normalized_item_id}-${row.profile_id}`}
            className="border-b border-border/40 last:border-0"
          >
            <td className="px-4 py-3">
              <p className="max-w-80 truncate text-xs">{row.source_url}</p>
              <p className="text-[11px] text-muted-foreground">
                {row.jurisdiction_hint ?? <em className="opacity-60">jurisdiction not stated</em>}
                {" · "}
                {row.category ?? <em className="opacity-60">category not stated</em>}
              </p>
            </td>
            <td className="px-4 py-3 text-xs text-muted-foreground">
              {row.profile_slug}
              <span className="ml-1 opacity-60">v{row.policy_version}</span>
            </td>
            <td className="px-4 py-3">
              <StatusBadge
                label={row.resolved_tier ?? "—"}
                tone={row.resolved_tier === "T5" ? "warn" : "ok"}
              />
            </td>
            <td className="px-4 py-3 text-[11px] text-muted-foreground">
              {row.is_official_domain ? "official" : "non-official"} ·{" "}
              {row.is_primary_document ? "primary" : "secondary"} · {row.traceability_level} ·{" "}
              {row.institution_class}
            </td>
            <td className="px-4 py-3">
              <StatusBadge
                label={row.promoted_for_profile ? "promoted" : "not promoted"}
                tone={row.promoted_for_profile ? "live" : "neutral"}
              />
            </td>
            <td className="px-4 py-3 text-xs text-muted-foreground">
              <div className="flex flex-col gap-2">
                <span>{formatDate(row.updated_at)}</span>
                <GlowButton
                  disabled={promote.isPending || !row.normalized_item_id || !row.profile_id}
                  onClick={() =>
                    promote.mutate({
                      normalizedItemId: row.normalized_item_id as string,
                      profileId: row.profile_id as string,
                      promoted: !row.promoted_for_profile,
                    })
                  }
                >
                  {row.promoted_for_profile ? "Remove promotion" : "Promote"}
                </GlowButton>
              </div>
            </td>
          </tr>
        ))}
      </DataTable>
    </section>
  );
}
