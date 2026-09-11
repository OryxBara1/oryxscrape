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
import { AnimatedStatusBadge } from "@/components/ui/animated-status-badge";
import { createSource, deleteSource, listSources, updateSource } from "@/lib/sources.functions";
import type { Database } from "@/integrations/supabase/types";

type Source = Database["public"]["Tables"]["sources"]["Row"];
type Traceability = Database["public"]["Enums"]["traceability_level"];
type InstitutionClass = Database["public"]["Enums"]["institution_class"];

const TRACEABILITY: Traceability[] = [
  "direct_url",
  "domain_indicated",
  "third_party_hosted",
  "untraceable",
];
const INSTITUTIONS: InstitutionClass[] = [
  "government",
  "intergovernmental",
  "court",
  "academic",
  "professional_body",
  "registered_media",
  "commercial",
  "unknown",
];
const STATUS_OPTIONS = ["unknown", "allowed", "restricted", "disallowed"];

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
  component: SourcesScreen,
});

const emptyDraft = {
  name: "",
  domain: "",
  start_url: "",
  is_official_domain: false,
  is_primary_document: false,
  traceability_level: "direct_url" as Traceability,
  institution_class: "unknown" as InstitutionClass,
  tos_status: "unknown",
  robots_status: "unknown",
};

function SourcesScreen() {
  const queryClient = useQueryClient();
  const fetchSources = useServerFn(listSources);
  const create = useServerFn(createSource);
  const update = useServerFn(updateSource);
  const remove = useServerFn(deleteSource);

  const [draft, setDraft] = useState(emptyDraft);
  const [showForm, setShowForm] = useState(false);
  const [savedPulse, setSavedPulse] = useState(false);

  const sources = useQuery({ queryKey: ["sources"], queryFn: () => fetchSources() });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["sources"] });

  const createMutation = useMutation({
    mutationFn: () => create({ data: draft }),
    onSuccess: () => {
      toast.success("Source created.");
      setDraft(emptyDraft);
      setShowForm(false);
      setSavedPulse(true);
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: (vars: { id: string; patch: Partial<Source> }) => update({ data: vars }),
    onSuccess: () => invalidate(),
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => remove({ data: { id } }),
    onSuccess: () => {
      toast.success("Source deleted.");
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const rows = sources.data ?? [];

  return (
    <section className="space-y-6">
      <ScreenHeader
        title="Sources"
        description="Scrape targets, ToS and robots.txt status, and the four objective provenance facts."
        action={
          <div className="relative">
            <AnimatedStatusBadge
              trigger={savedPulse}
              onAnimationComplete={() => setSavedPulse(false)}
            />
            <GlowButton onClick={() => setShowForm((v) => !v)}>
              {showForm ? "Cancel" : "New source"}
            </GlowButton>
          </div>
        }
      />

      {showForm ? (
        <form
          className="glass-panel grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            createMutation.mutate();
          }}
        >
          <Field label="Name">
            <input
              required
              className={inputClass}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <Field label="Domain">
            <input
              required
              className={inputClass}
              value={draft.domain}
              onChange={(e) => setDraft({ ...draft, domain: e.target.value })}
            />
          </Field>
          <Field label="Start URL">
            <input
              required
              className={inputClass}
              value={draft.start_url}
              onChange={(e) => setDraft({ ...draft, start_url: e.target.value })}
            />
          </Field>
          <Field label="Traceability">
            <select
              className={inputClass}
              value={draft.traceability_level}
              onChange={(e) =>
                setDraft({ ...draft, traceability_level: e.target.value as Traceability })
              }
            >
              {TRACEABILITY.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Institution class">
            <select
              className={inputClass}
              value={draft.institution_class}
              onChange={(e) =>
                setDraft({ ...draft, institution_class: e.target.value as InstitutionClass })
              }
            >
              {INSTITUTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-end gap-4">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={draft.is_official_domain}
                onChange={(e) => setDraft({ ...draft, is_official_domain: e.target.checked })}
              />
              Official domain
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={draft.is_primary_document}
                onChange={(e) => setDraft({ ...draft, is_primary_document: e.target.checked })}
              />
              Primary document
            </label>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <GlowButton type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Saving…" : "Create source"}
            </GlowButton>
          </div>
        </form>
      ) : null}

      {sources.error ? (
        <div className="glass-panel p-5 text-sm text-rose-300">
          {(sources.error as Error).message}
        </div>
      ) : null}

      <DataTable
        headers={["Source", "Objective facts", "Compliance", "Active", "Created", ""]}
        empty={!sources.isLoading && rows.length === 0}
      >
        {rows.map((source) => (
          <tr key={source.id} className="border-b border-border/40 last:border-0 align-top">
            <td className="px-4 py-3">
              <p className="font-medium">{source.name}</p>
              <p className="max-w-72 truncate text-xs text-muted-foreground">{source.start_url}</p>
            </td>
            <td className="px-4 py-3">
              <div className="flex flex-col gap-2 text-xs">
                <label className="flex items-center gap-2 text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={source.is_official_domain}
                    onChange={(e) =>
                      updateMutation.mutate({
                        id: source.id,
                        patch: { is_official_domain: e.target.checked },
                      })
                    }
                  />
                  official domain
                </label>
                <label className="flex items-center gap-2 text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={source.is_primary_document}
                    onChange={(e) =>
                      updateMutation.mutate({
                        id: source.id,
                        patch: { is_primary_document: e.target.checked },
                      })
                    }
                  />
                  primary document
                </label>
                <select
                  className={`${inputClass} py-1 text-xs`}
                  value={source.traceability_level}
                  onChange={(e) =>
                    updateMutation.mutate({
                      id: source.id,
                      patch: { traceability_level: e.target.value as Traceability },
                    })
                  }
                >
                  {TRACEABILITY.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <select
                  className={`${inputClass} py-1 text-xs`}
                  value={source.institution_class}
                  onChange={(e) =>
                    updateMutation.mutate({
                      id: source.id,
                      patch: { institution_class: e.target.value as InstitutionClass },
                    })
                  }
                >
                  {INSTITUTIONS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            </td>
            <td className="px-4 py-3">
              <div className="flex flex-col gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] uppercase text-muted-foreground">ToS</span>
                  <select
                    className={`${inputClass} py-1 text-xs`}
                    value={source.tos_status}
                    onChange={(e) =>
                      updateMutation.mutate({
                        id: source.id,
                        patch: {
                          tos_status: e.target.value,
                          tos_checked_at: new Date().toISOString(),
                        },
                      })
                    }
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] uppercase text-muted-foreground">
                    robots
                  </span>
                  <select
                    className={`${inputClass} py-1 text-xs`}
                    value={source.robots_status}
                    onChange={(e) =>
                      updateMutation.mutate({
                        id: source.id,
                        patch: {
                          robots_status: e.target.value,
                          robots_checked_at: new Date().toISOString(),
                        },
                      })
                    }
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </td>
            <td className="px-4 py-3">
              <button
                type="button"
                onClick={() =>
                  updateMutation.mutate({
                    id: source.id,
                    patch: { is_active: !source.is_active },
                  })
                }
              >
                <StatusBadge
                  label={source.is_active ? "active" : "paused"}
                  tone={source.is_active ? "live" : "neutral"}
                />
              </button>
            </td>
            <td className="px-4 py-3 text-xs text-muted-foreground">
              {formatDate(source.created_at)}
            </td>
            <td className="px-4 py-3">
              <GlowButton
                variant="ghost"
                disabled={deleteMutation.isPending}
                onClick={() => {
                  if (confirm(`Delete source "${source.name}"?`)) deleteMutation.mutate(source.id);
                }}
              >
                Delete
              </GlowButton>
            </td>
          </tr>
        ))}
      </DataTable>
    </section>
  );
}
