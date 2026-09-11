import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/tmp-piste-probe")({
  server: {
    handlers: {
      GET: async () => {
        const { getPisteToken } = await import("@/lib/piste.server");
        const token = await getPisteToken();
        const phrases = ["permis plaisance", "permis bateau"];

        const variants: Record<string, unknown> = {
          v1_all_ou: {
            champs: [
              {
                typeChamp: "ALL",
                criteres: phrases.map((p) => ({
                  typeRecherche: "EXPRESSION_EXACTE",
                  valeur: p,
                  operateur: "OU",
                })),
                operateur: "OU",
              },
            ],
          },
          v2_first_et: {
            champs: [
              {
                typeChamp: "ALL",
                criteres: phrases.map((p, i) => ({
                  typeRecherche: "EXPRESSION_EXACTE",
                  valeur: p,
                  operateur: i === 0 ? "ET" : "OU",
                })),
                operateur: "OU",
              },
            ],
          },
          v3_two_champs: {
            champs: phrases.map((p, i) => ({
              typeChamp: "ALL",
              criteres: [{ typeRecherche: "EXPRESSION_EXACTE", valeur: p, operateur: "ET" }],
              operateur: i === 0 ? "ET" : "OU",
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
