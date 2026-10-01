# Fix: the full-text lookup in the feed

Only `src/routes/api/public/feed.ts` changes, and only the `include_body=true` path. Requests without `include_body` stay exactly as they are now.

## Two notes before building

1. **The current helper already reads `plain_text`.** `pickBodyText` in `src/lib/body-text.ts` checks `plain_text` first, then `text`, `extracted_text`, `markdown`, `content` and `body`. So bug 2 does not happen in the current code. The real cause is the large fetch coming back empty, which this change fixes.
2. **The new lookup misses three keys the helper reads today:** `markdown`, `content` and `body`. Apify pages often keep their text in `markdown`, and older rows use `content` or `body`. Once the feed uses the new lookup, those items will come back with no body text. The new priority list below follows your spec exactly. If you want those three keys covered, a follow-up database change can add them to the lookup. That is not part of this build.

## Changes in feed.ts (body lookup block)

1. Change the `rawById` type to `Map<string, { body_text: string | null; collection_method: string }>`.
2. Replace the `raw_items` select with `supabaseAdmin.rpc("fetch_body_text_candidates", { p_ids: ids })`. The lookup is already in the generated types, so no cast is needed.
3. For each returned row, take the first value that is not empty after trimming, in this order: `plain_text`, `text_field`, `body_text_field`, `extracted_text`, `content_text`, `full_text`, `text_content`, `text_en`. Store `{ body_text: value ?? null, collection_method }`.
4. In the item mapping, replace `pickBodyText(...)` with `raw?.body_text ?? null`. The `contentSourceFor` and `text_length` logic stays the same.
5. Remove the `pickBodyText` import from feed.ts because nothing uses it any more. `body-text.ts` and the Drive handoff stay unchanged.
6. If the lookup returns an error, the feed still answers 500, as it does today.

## Not changed

Authentication, filters, paging, ordering, `next_since`, the 50-item limit with body text, the stats endpoint, and other files.

## Check after building

Look for a clean build. Then the feed with your real key, `include_body=true&limit=50`, should return CYC 2025 with `text_length` near 416,607 and GI items with their text.
