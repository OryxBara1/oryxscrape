# Malta collector with fallback to the Manual Upload Queue

This adds a collector for Transport Malta. It works through each document in the fixed order: direct download, then Parallel.ai, then Apify. Any document that all three fail on goes into the Manual queue with its link and jurisdiction MT already filled in. A one-time "Run retroactive pass" button retries the Malta documents that are already blocked or failed.

## Two corrections to the spec (they follow project rules)

1. **Blocked rows are not updated.** Raw items are never changed, and the database only lets staff insert and read them, so an update would fail. If a blocked Malta row has a wrong URL or is missing `jurisdiction_hint`, the pass **inserts a corrected blocked row** with `supersedes_raw_item_id` pointing to the old one. The queue already hides rows that have been replaced. Rows that are already correct are skipped, so no duplicates are created.
2. **Parallel Extract returns text, not PDF files.** Parallel reads the PDF on its own servers and sends back the full text as markdown. We store that text as-is (`payload_integrity = 'verbatim'`, `collector_version = parallel-extract@1.0.0`). We never receive the original file from Parallel, which is how the existing fallback in `pdf-collect` already works.

## Files

| File | Change |
|---|---|
| `src/lib/malta-collect.server.ts` | new: finds documents, runs the fallback chain, records blocked items |
| `src/lib/malta.functions.ts` | new: staff-only `startMaltaCollection` and `runMaltaRetroactivePass` |
| `src/lib/collection.functions.ts` | send sources on `transport.gov.mt` to the Malta collector, so the Collection jobs screen can start it |
| `src/routes/_authenticated/admin.manual-queue.tsx` | "Run retroactive pass" button with a confirm step and a results summary |
| `roadmap.md` | Malta entry |

No database migrations, no scheduled runs, no Edge Functions.

## Flow

```text
Listing page (the source's start_url)
  1. direct HTTP fetch, then read the PDF links
  2. if blocked or the page looks empty: Parallel Extract of the listing, then read links from the markdown
  3. still nothing: Parallel Search limited to transport.gov.mt for PDF links
For each document URL, stop at the first step that works:
  a. direct HTTP (same checks as pdf-collect: %PDF signature, text read with unpdf)
  b. Parallel Extract (full text)
  c. Apify website-content-crawler (sync run, 1 page, browser crawler)
  d. recordBlockedItem(url, source, "MT", combined error from a, b and c)
Successes become a new raw item (collected, hash of the text, never overwritten)
and start as unreviewed / internal_only. Nothing is approved automatically.
```

## Technical details

**Function signatures (`malta-collect.server.ts`)**

```ts
export const MALTA_COLLECTOR_VERSION = "malta-collect@1.0.0";

export async function discoverMaltaDocuments(startUrl: string):
  Promise<{ urls: string[]; via: "http" | "parallel-extract" | "parallel-search" }>;

type Attempt = { engine: "http" | "parallel" | "apify"; ok: boolean; error?: string };
export async function collectMaltaDocument(url: string): Promise<
  | { ok: true; text: string; title: string | null; engine: Attempt["engine"];
      collectorVersion: string; attempts: Attempt[] }
  | { ok: false; attempts: Attempt[]; error: string }>;

export async function runMaltaCollection(input: {
  supabase: SupabaseClient<Database>; source: SourceFacts & { start_url: string };
  profileId: string | null; maxDocuments?: number; // default 15, keeps each run within time limits
}): Promise<{ jobId: string; found: number; ingested: number;
              duplicates: number; blocked: number; failed: number }>;

export async function runMaltaRetroactivePass(input: {
  supabase: SupabaseClient<Database>; sourceId: string; limit?: number; // default 15
}): Promise<{ checked: number; recovered: number; stillBlocked: number;
              corrected: number; skipped: number }>;
```

`collectMaltaDocument` calls the engines one after another in a fixed sequence (`http`, then `parallel`, then `apify`), never in parallel, so Apify can never run before Parallel. The job is recorded in `collection_jobs` (running, then succeeded or failed with per-URL attempts in `run_params`).

**How Parallel Extract fetches a PDF by URL.** This reuses `extractWithParallel` from `parallel-fetch.server.ts`, which picks the Lovable connection or a direct key automatically:

```ts
const r = await extractWithParallel(url,
  "Extract the full text of this Transport Malta regulatory PDF (notices, merchant shipping rules).");
// POST {gateway|api.parallel.ai}/v1/extract
// { urls:[url], excerpts:false, full_content:{max_chars_per_result:100000},
//   advanced_settings:{fetch_policy:{timeout_seconds:60}} }
// -> results[0].full_content (markdown text); errors[] means that step failed
```

Text shorter than 200 characters counts as a failure and moves on to Apify. Discovery uses the same call on the listing page and pulls `.pdf` links out of the markdown.

**Apify step.** This uses the existing `apify.server.ts` with the already-configured actor `apify~website-content-crawler`, using `crawlerType: "playwright:firefox"`, `maxCrawlPages: 1`, and `run-sync-get-dataset-items` with a short timeout. `apify/pdf-scraper` is not in the codebase and would need to be checked first. The step is written so the actor can be swapped later.

**Retroactive pass rules.**
- Reads Malta raw items with `item_status in ('failed','blocked')`, then drops any row that another row supersedes. Those rows are "not yet replaced"; the rows' own `supersedes_raw_item_id` column is not what matters here.
- Recovered: inserts a collected row that supersedes the old one.
- Still blocked and the row is already correct: skipped.
- Still blocked and the row is wrong: inserts a corrected blocked row that supersedes the old one. Its hash is `blocked|source|url|retro`, so the unique index is not hit. This needs a small optional `supersedes` argument on `recordBlockedItem`, and that is the only change to that file.
- "One-time" is enforced in the app: the button only shows while unreplaced failed or blocked Malta rows exist. The pass can safely run again because finished rows are skipped.

**Transport Malta source.** The collector looks the source up by domain `transport.gov.mt`. If none exists, `startMaltaCollection` returns a clear error telling staff to add it on Sources (official domain, government). It does not create one silently.

## Out of scope

Scheduled runs, other Malta sources (legislation.mt), a DOCX parser, and storing the original files.
