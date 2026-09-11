import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/tmp-piste-probe")({
  server: {
    handlers: {
      GET: async () => {
        const { getPisteToken } = await import("@/lib/piste.server");
        const token = await getPisteToken();
        const phrases = ["permis plaisance", "permis bateau"];

        const variants: Record<string, unknown> = {
          a_single_exact: {
            champs: [
              {
                typeChamp: "ALL",
                criteres: [
                  { typeRecherche: "EXPRESSION_EXACTE", valeur: phrases[0], operateur: "ET" },
                ],
                operateur: "ET",
              },
            ],
          },
          b_two_undesmots_ou: {
            champs: [
              {
                typeChamp: "ALL",
                criteres: phrases.map((p) => ({
                  typeRecherche: "UN_DES_MOTS",
                  valeur: p,
                  operateur: "OU",
                })),
                operateur: "ET",
              },
            ],
          },
          c_two_exact_prox: {
            champs: [
              {
                typeChamp: "ALL",
                criteres: phrases.map((p) => ({
                  typeRecherche: "EXPRESSION_EXACTE",
                  valeur: p,
                  operateur: "OU",
                  proximite: 2,
                })),
                operateur: "ET",
              },
            ],
          },
          d_two_champs_ou: {
            champs: phrases.map((p) => ({
              typeChamp: "ALL",
              criteres: [{ typeRecherche: "UN_DES_MOTS", valeur: p, operateur: "ET" }],
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
