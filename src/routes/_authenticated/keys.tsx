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
  createConsumerKey,
  listConsumerKeys,
  revokeConsumerKey,
} from "@/lib/consumer-keys.functions";
import { listResearchProfiles } from "@/lib/items.functions";

export const Route = createFileRoute("/_authenticated/keys")({
  head: () => ({
    meta: [
      { title: "Consumer keys — OryxScrape" },
      {
        name: "description",
        content: "Issue and revoke bearer keys used by consumer apps to pull normalized data.",
      },
      { property: "og:title", content: "Consumer keys — OryxScrape" },
      {
        property: "og:description",
        content: "Issue and revoke read-only API keys for OryxScrape consumer apps.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: KeysScreen,
});

function KeysScreen() {
  const fetchKeys = useServerFn(listConsumerKeys);
  const fetchProfiles = useServerFn(listResearchProfiles);
  const create = useServerFn(createConsumerKey);
  const revoke = useServerFn(revokeConsumerKey);
  const queryClient = useQueryClient();

  const [consumerApp, setConsumerApp] = useState("");
  const [profileId, setProfileId] = useState("");
  const [note, setNote] = useState("");
  const [issuedKey, setIssuedKey] = useState<string | null>(null);

  const keys = useQuery({ queryKey: ["consumer-keys"], queryFn: () => fetchKeys() });
  const profiles = useQuery({ queryKey: ["research-profiles"], queryFn: () => fetchProfiles() });

  const createMutation = useMutation({
    mutationFn: () => create({ data: { consumerApp, profileId, note } }),
    onSuccess: (result) => {
      setIssuedKey(result.rawKey);
      setConsumerApp("");
      setNote("");
      void queryClient.invalidateQueries({ queryKey: ["consumer-keys"] });
      toast.success("Key created — copy it now, it is shown only once.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revoke({ data: { id } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["consumer-keys"] });
      toast.success("Key revoked.");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const rows = keys.data ?? [];

  return (
    <section className="space-y-6">
      <ScreenHeader
        title="Consumer keys"
        description="Bearer keys for GET /api/public/v1/items. Only a hash is stored — the raw key is shown once."
      />

      {issuedKey ? (
        <div className="glass-panel space-y-3 p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-primary">
            New key — copy it now
          </p>
          <code className="block break-all rounded-lg border border-primary/30 bg-black/30 p-3 font-mono text-xs">
            {issuedKey}
          </code>
          <div className="flex gap-2">
            <GlowButton
              onClick={() => {
                void navigator.clipboard.writeText(issuedKey);
                toast.success("Copied.");
              }}
            >
              Copy
            </GlowButton>
            <GlowButton variant="ghost" onClick={() => setIssuedKey(null)}>
              Dismiss
            </GlowButton>
          </div>
        </div>
      ) : null}

      <form
        className="glass-panel grid gap-4 p-5 md:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          createMutation.mutate();
        }}
      >
        <Field label="Consumer app">
          <input
            className={inputClass}
            value={consumerApp}
            onChange={(e) => setConsumerApp(e.target.value)}
            placeholder="auramaris"
            required
          />
        </Field>
        <Field label="Research profile">
          <select
            className={inputClass}
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
            required
          >
            <option value="">Select…</option>
            {(profiles.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.slug}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note (optional)">
          <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex items-end">
          <GlowButton type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? "Creating…" : "Create key"}
          </GlowButton>
        </div>
      </form>

      {keys.error ? (
        <div className="glass-panel p-5 text-sm text-rose-300">{(keys.error as Error).message}</div>
      ) : null}

      <DataTable
        headers={["Consumer app", "Prefix", "Profile", "Status", "Created", "Last used", "Revoked", ""]}
        empty={!keys.isLoading && rows.length === 0}
      >
        {rows.map((key) => (
          <tr key={key.id} className="border-b border-border/40 last:border-0">
            <td className="px-4 py-3">
              <p className="font-medium">{key.consumer_app}</p>
              {key.note ? <p className="text-xs text-muted-foreground">{key.note}</p> : null}
            </td>
            <td className="px-4 py-3 font-mono text-xs">{key.key_prefix}…</td>
            <td className="px-4 py-3 text-xs text-muted-foreground">
              {key.research_profiles?.slug ?? "—"}
            </td>
            <td className="px-4 py-3">
              <StatusBadge
                label={key.is_active ? "active" : "revoked"}
                tone={key.is_active ? "ok" : "bad"}
              />
            </td>
            <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(key.created_at)}</td>
            <td className="px-4 py-3 text-xs text-muted-foreground">
              {formatDate(key.last_used_at)}
            </td>
            <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(key.revoked_at)}</td>
            <td className="px-4 py-3 text-right">
              {key.is_active ? (
                <GlowButton
                  variant="ghost"
                  disabled={revokeMutation.isPending}
                  onClick={() => revokeMutation.mutate(key.id)}
                >
                  Revoke
                </GlowButton>
              ) : null}
            </td>
          </tr>
        ))}
      </DataTable>
    </section>
  );
}
