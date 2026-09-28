import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";

import { DataTable, Field, GlowButton, ScreenHeader, StatusBadge, inputClass } from "@/components/data-ui";
import {
  listProfilesFull,
  listPromotionCandidates,
  saveProfile,
  setPromotion,
} from "@/lib/profiles.functions";

export const Route = createFileRoute("/_authenticated/profiles")({
  head: () => ({
    meta: [
      { title: "Perfis de consumidores — OryxScrape" },
      { name: "description", content: "Gerencie os perfis (filhotes) que consomem o feed regulatório." },
      { property: "og:title", content: "Perfis de consumidores — OryxScrape" },
      { property: "og:description", content: "Países, tags e liberação de documentos por filhote." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: ProfilesScreen,
});

type Form = {
  id?: string;
  slug: string;
  name: string;
  description: string;
  is_active: boolean;
  jur: string;
  tags: string;
  require_promotion: boolean;
};
const EMPTY: Form = { slug: "", name: "", description: "", is_active: true, jur: "", tags: "", require_promotion: false };
const split = (s: string) => s.split(",").map((v) => v.trim()).filter(Boolean);

function ProfilesScreen() {
  const qc = useQueryClient();
  const fetchProfiles = useServerFn(listProfilesFull);
  const save = useServerFn(saveProfile);
  const [form, setForm] = useState<Form>(EMPTY);
  const [selected, setSelected] = useState<string | null>(null);

  const profiles = useQuery({ queryKey: ["profiles-full"], queryFn: () => fetchProfiles() });

  const saveM = useMutation({
    mutationFn: () =>
      save({
        data: {
          ...(form.id ? { id: form.id } : {}),
          slug: form.slug.trim(),
          name: form.name,
          description: form.description,
          is_active: form.is_active,
          allowed_jurisdictions: split(form.jur),
          allowed_tags: split(form.tags),
          require_promotion: form.require_promotion,
        },
      }),
    onSuccess: () => {
      toast.success("Perfil salvo.");
      setForm(EMPTY);
      void qc.invalidateQueries({ queryKey: ["profiles-full"] });
      void qc.invalidateQueries({ queryKey: ["research-profiles"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="space-y-6">
      <ScreenHeader
        title="Perfis (filhotes)"
        description="Cada chave de API pertence a um perfil. O feed só entrega os países e tags do perfil — vazio significa sem restrição."
      />

      <form
        className="glass-panel grid gap-4 p-5 md:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          saveM.mutate();
        }}
      >
        <Field label="Slug">
          <input className={inputClass} value={form.slug} disabled={!!form.id} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="portos-cargas" required />
        </Field>
        <Field label="Nome">
          <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </Field>
        <Field label="Descrição">
          <input className={inputClass} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <Field label="Países (vírgula) — ex.: EU, FR, ES">
          <input className={inputClass} value={form.jur} onChange={(e) => setForm({ ...form, jur: e.target.value })} />
        </Field>
        <Field label="Tags (vírgula)">
          <input className={inputClass} value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
        </Field>
        <div className="flex flex-col justify-end gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /> Ativo
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.require_promotion} onChange={(e) => setForm({ ...form, require_promotion: e.target.checked })} /> Só documentos liberados manualmente
          </label>
        </div>
        <div className="flex gap-2 md:col-span-3">
          <GlowButton type="submit" disabled={saveM.isPending}>{form.id ? "Salvar alterações" : "Criar perfil"}</GlowButton>
          {form.id ? <GlowButton variant="ghost" type="button" onClick={() => setForm(EMPTY)}>Cancelar</GlowButton> : null}
        </div>
      </form>

      {profiles.error ? <div className="glass-panel p-5 text-sm text-destructive">{(profiles.error as Error).message}</div> : null}

      <DataTable headers={["Perfil", "Países", "Tags", "Liberação", "Status", ""]} empty={!profiles.isLoading && (profiles.data ?? []).length === 0}>
        {(profiles.data ?? []).map((p) => (
          <tr key={p.id} className="border-b border-border/40 last:border-0">
            <td className="px-4 py-3">
              <p className="font-medium">{p.name}</p>
              <p className="font-mono text-xs text-muted-foreground">{p.slug}</p>
            </td>
            <td className="px-4 py-3 text-xs">{p.allowed_jurisdictions.join(", ") || "todos"}</td>
            <td className="px-4 py-3 text-xs">{p.allowed_tags.join(", ") || "todas"}</td>
            <td className="px-4 py-3 text-xs">{p.require_promotion ? "manual" : "automática"}</td>
            <td className="px-4 py-3"><StatusBadge label={p.is_active ? "ativo" : "inativo"} tone={p.is_active ? "ok" : "bad"} /></td>
            <td className="space-x-2 px-4 py-3 text-right">
              <GlowButton
                variant="ghost"
                onClick={() =>
                  setForm({
                    id: p.id,
                    slug: p.slug,
                    name: p.name,
                    description: p.description ?? "",
                    is_active: p.is_active,
                    jur: p.allowed_jurisdictions.join(", "),
                    tags: p.allowed_tags.join(", "),
                    require_promotion: p.require_promotion,
                  })
                }
              >
                Editar
              </GlowButton>
              <GlowButton variant="ghost" onClick={() => setSelected(p.id)}>Liberar itens</GlowButton>
            </td>
          </tr>
        ))}
      </DataTable>

      {selected ? (
        <PromotionPanel
          profileId={selected}
          profileName={profiles.data?.find((p) => p.id === selected)?.name ?? ""}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  );
}

function PromotionPanel({ profileId, profileName, onClose }: { profileId: string; profileName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const fetchItems = useServerFn(listPromotionCandidates);
  const toggle = useServerFn(setPromotion);
  const [search, setSearch] = useState("");
  const key = ["promotion", profileId, search];
  const items = useQuery({ queryKey: key, queryFn: () => fetchItems({ data: { profileId, search } }) });
  const m = useMutation({
    mutationFn: (v: { itemId: string; promoted: boolean }) => toggle({ data: { profileId, ...v } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["promotion", profileId] }),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="glass-panel space-y-4 p-5">
      <div className="flex items-center justify-between gap-4">
        <p className="font-medium">Liberar documentos aprovados para: {profileName}</p>
        <GlowButton variant="ghost" onClick={onClose}>Fechar</GlowButton>
      </div>
      <input className={inputClass} placeholder="Filtrar por URL…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <DataTable headers={["Documento", "País", "Liberado"]} empty={!items.isLoading && (items.data ?? []).length === 0}>
        {(items.data ?? []).map((i) => (
          <tr key={i.id} className="border-b border-border/40 last:border-0">
            <td className="px-4 py-3">
              <p className="text-sm">{i.title ?? "(sem título)"}</p>
              <p className="truncate font-mono text-xs text-muted-foreground">{i.source_url}</p>
            </td>
            <td className="px-4 py-3 text-xs">{i.jurisdiction ?? "—"}</td>
            <td className="px-4 py-3">
              <input
                type="checkbox"
                aria-label="Liberado para este perfil"
                checked={i.promoted}
                disabled={m.isPending}
                onChange={(e) => m.mutate({ itemId: i.id, promoted: e.target.checked })}
              />
            </td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}
