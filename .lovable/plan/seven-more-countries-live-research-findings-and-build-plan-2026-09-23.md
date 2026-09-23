# Seven more countries — live research findings and build plan

Everything below comes from real requests made today, not from documentation.

## Verdict table

| Country | Source tested | Keyword search | Date window | Paging | Full text | Verdict |
|---|---|---|---|---|---|---|
| UK | legislation.gov.uk Atom | yes | by year (path) | yes | yes, XML | **Direct API — build** |
| Netherlands | repository.overheid.nl SRU | yes | yes (exact) | yes | yes, XML | **Direct API — build** |
| Brazil | in.gov.br DOU search | yes | yes (exact) | yes | yes, page per item | **Parse embedded data — build** |
| Italy | normattiva / dati.normattiva | blocked | — | — | — | **Skip for now** |
| Germany | openlegaldata / gesetze-im-internet | no real search | no | n/a | partly | **Skip the API; keep crawler** |
| Croatia | narodne-novine.nn.hr | not over a plain link | no | — | yes, per issue | **Keep the existing crawler** |
| Portugal | diariodarepublica.pt | not over a plain link | — | — | yes, PDF | **Browser-based collector** |

## What each test showed

**United Kingdom — usable, best of the seven.** No key, no account.
`https://www.legislation.gov.uk/all/{year}/data.feed?text={term}&page={n}` answers an Atom
feed; "vessel" for 2026 returned 50 items, each with title, publication date and a direct
link to the full legal text as XML (verified on SI 2026/577). One caveat found by testing:
`start-date`/`end-date` in the address are silently ignored — only the year in the path
actually filters — so the 7-day window has to be applied by us after reading the dates in
the feed, and around New Year we query both years.

**Netherlands — usable.** No key. `https://repository.overheid.nl/sru` covers the
Staatscourant, official announcements and parliamentary papers together. A search for
"pleziervaart" limited to items available since 1 August 2026 returned 9 results with
title, summary, language and publication date, and the full text of one of them
(`wsb-2026-20581`) downloaded cleanly as XML. Real date filtering, real paging, real
keyword search — the closest match to the Spain collector.

**Brazil — usable with one extra step.** The official gazette search at
`in.gov.br/consulta/-/buscar/dou` accepts the search word and an exact from/to date pair
and returns the result list as structured data embedded inside the page, including title,
section, publication date, an excerpt and the address of each item. Verified with
"embarcação" over 1–23 September 2026. It is not a documented API, so it is slightly more
fragile than the UK/NL routes and we keep the full page we received as evidence. The
alternative sources you named are not available: Querido Diário's service answered "no
available server" on every attempt, and INLABS rejected the request outright (it needs a
gov.br login anyway, and it carries municipal/federal gazettes rather than consolidated law).

**Italy — blocked.** Every address under `dati.normattiva.it` and `normattiva.it/api`
answered 409 "page blocked by the protection systems of the State Printing Office",
including the service's own configuration file. Nothing is readable from our servers today,
regardless of the February open-data launch. Italy stays as it is (manual, PDF-based) until
either the block lifts or we route Italy through the Apify proxy like Croatia.

**Germany — no usable search.** `de.openlegaldata.io` answers and is open, but the search
word is ignored: "Sportboot" and "Sportbootführerschein" both return the entire corpus of
176,915 records in the same order, so it cannot find nautical law. It also has no publication
date to filter on. `gesetze-im-internet.de` was unreachable from our servers entirely;
`recht.bund.de` (the new Bundesgesetzblatt) does answer, but it is a browser application, not
a data service. Germany keeps its current working crawler; no API collector is honest here.

**Croatia — same conclusion as before.** The ELI addresses work and the individual issue
pages are readable, but the search page is a form that does not run a query from a plain
link (the results only appear after a form submission). So there is no date+keyword search
to call. Croatia's existing crawler stays; a Thursday slot would add nothing new.

**Portugal — browser only.** Both the current site and the old dre.pt address return the
same empty application shell; the search runs entirely inside the browser. So Portugal needs
either the Apify browser crawler on its search page, or the document-by-document PDF route
already used for it in this project. No plain data service exists.

## Proposed build

Three collectors now, in exactly the France/Spain pattern — a protected scheduled endpoint
plus a server module, 7-day rolling publication window, per-term paging with the 5-page /
100-document ceiling, SHA-256 dedup against `raw_items`, immutable `raw_items` then
`normalized_items` at `unreviewed` / `internal_only`, job row `running` → `succeeded`/`failed`
with counts, HTTP 500 with a JSON error body on failure, and step-by-step logging.

1. `src/lib/uk-legislation.server.ts` + `/api/public/cron/collect-uk-legislation`
   — Sunday 03:00 UTC. `collection_method = 'api'`.
2. `src/lib/nl-overheid.server.ts` + `/api/public/cron/collect-nl-overheid`
   — Friday 03:00 UTC. `collection_method = 'api'`.
3. `src/lib/br-dou.server.ts` + `/api/public/cron/collect-br-dou`
   — Monday 09:00 UTC. `collection_method = 'scrape'`.

Each needs a row in `sources` (UK legislation.gov.uk, NL overheid.nl, BR in.gov.br) with the
provenance facts set the same way as the existing official-gazette sources; Brazil and the UK
have no row yet. The weekly scheduler gets one branch per new collector, as Spain did.

Not built: Italy, Germany, Croatia, Portugal — with the reasons above. Croatia and Germany
already collect through the crawler, so nothing is lost; Italy and Portugal would need a
browser-based run, which I can add as a separate step if you want their slots filled.

## What I need from you

1. **Search terms per country** — you said you would provide them. I need English (UK),
   Dutch (NL) and Brazilian Portuguese (BR) lists, the same shape as the nine Spanish terms.
2. **Italy and Portugal** — leave the Wednesday and Tuesday-09:00 slots empty for now, or
   should I plan browser-based collectors for them as a follow-up?
3. **Croatia and Germany** — confirm they keep their current weekly crawler and we drop the
   Thursday/Saturday API slots.
4. Backfill stays parked until 1–2 clean runs, same rule as France and Spain — confirm.
