# Fix 1: the feed delivers the full body text from the collected record

Every approved document in the feed will carry its full text, taken from the collected record, which is the evidence that is never edited. The summary record stays as the layer for metadata and editorial eligibility. Rejected and internal-only documents stay excluded, exactly as today.

## Answers to your questions

1. **Where the text is stored.** For CYC 2025 it is in `raw_items.raw_payload`, under the keys `text` and `plain_text`. Both hold the same 416,607 characters, on the collected record `772a0add-...`. The summary record (`normalized_items` `019a7681-...`) points to it through `raw_item_id`, and its own `payload` holds no text. Other collectors use other keys: Parallel uses `text`, Apify pages use `markdown` or `text`, and older rows use `extracted_text`, `content` or `body`.
2. **How the feed is built today.** `src/routes/api/public/feed.ts`, GET handler. It checks the key, then queries `normalized_items` filtered to `publication_status = 'eligible'` (plus the profile's jurisdiction and tag rules and promotion), and builds each item from the summary's own fields. `text` is `payload.text` or `payload.plain_text` from the **summary** only, so CYC comes out as `null`. It never reads `raw_items`.
3. **New fields in each item.** Details are below. The existing `text` field is kept so the consumer keeps working.
4. **Old records.** The feed will read the text live, so any call that re-reads a document gets its text. But a consumer that syncs using `since` only receives documents whose `updated_at` changed, and CYC's has not. So one deliberate re-delivery is needed; see step 4.
5. **Very large text.** A single 416,000-character document is about 0.4 MB of JSON, which the server and HTTP handle fine. The risk is the page size: up to 500 items, each possibly large, could produce responses of tens of MB and run into server memory and time limits. So the plan caps it; see step 3.
6. **What stays the same.** Eligibility, rejection, the profile's jurisdiction and tag rules, promotion, ordering, the paging cursor, and the summary record. Rejected items are internal only and stay out. No database changes.

## Implementation steps

1. **Shared text rule.** Create `src/lib/body-text.ts` (it has no server-only imports, so the route can use it). It exports `pickBodyText(rawPayload)`, which reads the keys in this order: `plain_text`, `text`, `extracted_text`, `markdown`, `content`, `body`. It returns the first one that is not empty after trimming, otherwise `null`. It also exports `contentSourceFor(collection_method)`, which maps `manual` → `"manual_upload"`, `parallel_extract` → `"parallel"`, `apify` → `"apify"`, `http` → `"direct_http"`, and `api` → `"official_api"`. `exchange.server.ts`, which prepares the Drive handoff, switches to the same rule, so the feed and the handoff can never disagree.
2. **Feed query** (`feed.ts`). Add `raw_item_id` to the selected columns. After the page of summaries is fetched, run one more query: `raw_items.select("id, raw_payload, collection_method").in("id", ids)`. That is one extra call per page, with no per-item loop. Then attach the three new fields to each item. `raw_item_id` itself is still never returned.
3. **Size guard.** Add a new parameter `include_body`, which defaults to `true`. When body text is included, the largest allowed `limit` drops from 500 to **50**. A request above 50 gets `400 "limit > 50 with include_body"`; nothing is quietly shortened. Sending `include_body=false` restores the current limit of 500 and skips the extra query. `next_since` and `has_more` work the same either way. The worst case is about 50 × 0.4 MB, around 20 MB, which is acceptable.
4. **Retroactive delivery.** This is one data update, approved by you and run once, with no schema change. It sets `updated_at = now()` on eligible items whose collected record has body text but whose summary has none (CYC 2025 is one). The trigger that records review changes fires only when a status changes, so it does not fire here. The next `since` sync then re-sends those items with their text. The consumer app already updates items by `id`, so there are no duplicates. The other option needs no data change: ask the consumer to do one full re-sync from the start.
5. **Stats endpoint** (`feed.stats.ts`): unchanged.
6. **Docs.** Update the header comment of `feed.ts`, and in `roadmap.md` mark Fix 1 done. Fix 2 (the consumer app asking for a re-extraction) stays open as a later item.

## New item shape

```json
{
  "id": "019a7681-a641-4960-a63e-08756391fe9a",
  "source_url": "https://www.transport.gov.mt/CYC-2025.pdf-f10643",
  "jurisdiction": "MT",
  "category": "...",
  "title": "COMMERCIAL YACHT CODE (CYC) 2025",
  "doc_type": "...",
  "text": null,
  "body_text": "COMMERCIAL YACHT CODE ... (416607 chars)",
  "content_source": "manual_upload",
  "text_length": 416607,
  "tags": [],
  "traceability_level": "direct_url",
  "institution_class": "government",
  "is_official_domain": true,
  "is_primary_document": true,
  "collected_at": "2026-09-30T07:19:21Z",
  "reviewed_at": "..."
}
```

When no text exists, the item has `"body_text": null, "content_source": null, "text_length": 0`, never an empty string. With `include_body=false`, all three fields are left out.

## Files

- `src/lib/body-text.ts`: new
- `src/routes/api/public/feed.ts`: edited
- `src/lib/exchange.server.ts`: uses the shared rule
- `roadmap.md`
- Plus the one-time data update in step 4

## Risks

- **The consumer syncs with `limit` above 50.** It would get a 400 until it lowers its page size or sends `include_body=false`. This must be communicated before publishing.
- **Scanned PDFs** have no text layer, so they still show `text_length: 0` until OCR exists (out of scope).
- **`markdown` from Apify** can include menus and page chrome. It is still the verbatim collected text, and `content_source` shows where it came from.
- **`src/routes/api/public/v1/items.ts`** is a separate older endpoint and is not changed in this fix.
- **Publishing:** the change only reaches the live address after the site is published.
