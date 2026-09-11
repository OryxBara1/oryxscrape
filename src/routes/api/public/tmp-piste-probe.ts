import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/tmp-piste-probe")({
  server: {
    handlers: {
      GET: async () => {
        const { getPisteToken } = await import("@/lib/piste.server");
        const token = await getPisteToken();
        const phrases = ["permis plaisance", "permis bateau"];

        const variants: Record<string, unknown> = {
          e_champs_exact_ou: {
            champs: phrases.map((p) => ({
              typeChamp: "ALL",
              criteres: [{ typeRecherche: "EXPRESSION_EXACTE", valeur: p, operateur: "ET" }],
              operateur: "OU",
            })),
          },
          f_champs_tous_mots_ou: {
            champs: phrases.map((p) => ({
              typeChamp: "ALL",
              criteres: [
                { typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP", valeur: p, operateur: "ET" },
              ],
              operateur: "OU",
            })),
          },
        };



        const out: Record<string, unknown> = {};
        for (const [name, part] of Object.entries(variants)) {
          const body = {
            fond: "LODA_DATE",
            recherche: {
              ...(part as object),
              filtres: [{ facette: "DATE_VERSION", singleDate: Date.now() }],
              pageNumber: 1,
              pageSize: 2,
              operateur: "ET",
              sort: "PERTINENCE",
              typePagination: "DEFAUT",
            },
          };
          const res = await fetch(
            "https://api.piste.gouv.fr/dila/legifrance/lf-engine-app/search",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify(body),
            },
          );
          const text = await res.text();
          let titles: unknown = null;
          try {
            const json = JSON.parse(text) as { results?: { titles?: { title?: string }[] }[] };
            titles = (json.results ?? []).flatMap((r) => (r.titles ?? []).map((t) => t.title));
          } catch {
            titles = null;
          }
          out[name] = { status: res.status, titles, body: res.ok ? undefined : text.slice(0, 300) };
        }
        return Response.json(out);
      },
    },
  },
});
