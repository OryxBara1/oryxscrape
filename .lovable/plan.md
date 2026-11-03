# Phase 1B step 3a — review fixes (proposal only)

Status: PROPOSAL. No code changes until this review is approved. No publishing, flags, test source, real downloads, service writes, schema or Storage changes.
3a remains: implemented and validated with mocks only; NOT approved for publishing, real tests or activation.

## 1. Enforce the byte limit while reading the body (enabled path only)

### Problem
In the enabled path the body is still read with `arrayBuffer()`, and the size is checked afterwards. That limits what is stored, not how much is downloaded into memory.

### Proposed change
New function `readBodyCapped(response, cap, signal)` in `document-storage.server.ts`. It reads the body through `response.body.getReader()`, counting bytes as they arrive:
- It looks at the first chunk.
  - If the chunk does not start with `%PDF`, it hands back control and the rest of the body is read the old way (concatenating chunks with no cap). HTML handling stays exactly as today.
  - If it is a PDF, counting starts.
- When the running total would pass `cap` (52428800): `reader.cancel()` stops the rest of the response from being consumed. The function returns `{ kind: "over_limit", bytesRead }` and keeps no data.
- Content-Length is used only for sizing:
  - Known and ≤ cap: one buffer of exactly that size is allocated and chunks are copied into it as they arrive (no second copy). If more bytes arrive than declared, the read is still counted and cancelled at the cap.
  - Missing, or over the cap: no up-front buffer. Chunks are collected and joined once at the end. Peak memory is about twice the file size for that one moment, still bounded by the cap.
  - A Content-Length over the cap does not stop the read before it starts. It is only a hint, so the actual count decides.
- Read timeout: 60 s, through the same abort signal. On timeout the reader is cancelled.

### Integration in `pdf-collect.server.ts`, direct-fetch success branch only
```text
flag off:  bytes = new Uint8Array(await okResponse.arrayBuffer())        (unchanged)
flag on:   r = await readBodyCapped(okResponse, MAX_ORIGINAL_BYTES, signal)
           r.kind = "ok"         -> bytes = r.bytes; continue as today
           r.kind = "non_pdf"    -> bytes = r.bytes; continue as today (HTML unchanged)
           r.kind = "over_limit" -> no bytes; no upload, no copy row;
                                    original = not_stored_size_limit;
                                    text path = owner decision D1 (section 2)
```
`preserveOriginal` is never called for `over_limit`, so no upload is ever started for that file.

### Read tests (mock streams, not a finished ArrayBuffer)
A test `ReadableStream` gives out chunks one at a time on `pull`, counting how many it gave and recording `cancel()`:
- R1 no Content-Length, body larger than the cap: the result is `over_limit`; `cancel()` was called; chunks given ≤ the number needed to pass the cap plus one; later chunks are never read.
- R2 Content-Length smaller than the real body (a lie): cancelled at the cap, same assertions.
- R3 Content-Length larger than the cap but a small real body: read normally. The header doesn't decide.
- R4 body exactly at the cap: `ok`, no cancel.
- R5 non-PDF first chunk: no cap applied; bytes match the full body.
- R6 over limit inside `runPdfCollection` with the switch on: no `upload`, no `insertPending`, no sighting with a copy. After waiting past every timer, the write counters have not changed (no late writes).
- R7 read timeout: the reader is cancelled and no writes follow.

For memory, tests use chunk counts and sizes no larger than needed (e.g. a 1 KB cap through an injectable `cap` argument, plus one real 52428800 boundary test).

## 2. Inline extraction cap `ORIGINALS_INLINE_EXTRACT_MAX_BYTES`

### Rule
- Switch off: unchanged. Every PDF is parsed with `unpdf`, as today.
- Switch on: `unpdf` runs only if `size ≤ inlineCap`.
  - **Default when the variable is unset: 0, so no inline parsing in the enabled path.** The owner must set the variable explicitly, from measurements, before any PDF is parsed in the enabled path. This is the "explicit decision".
  - The value is read inside the handler. Anything that is not a positive whole number is treated as 0.
- PDFs over the inline cap (and `over_limit` PDFs) are still stored when ≤ 52428800, but they are not parsed.

### Effect on collection results: owner decision D1
For a PDF that is not parsed inline, the text must come from somewhere else. Each option visibly changes the result compared with the switch off:

| Option | Text / content_hash | Other differences |
|---|---|---|
| A. Fall back to Parallel Extract on the same URL | Different text, so a **different content_hash**: a separate raw item from the one the switch-off path would create | `extraction_method: parallel_extract`, `collector_version` Parallel, `attempts` records `{engine:"inline_pdf", ok:false, error:"inline_extract_cap"}` |
| B. Blocked record (manual queue) with reason `inline_extract_cap` | No text; blocked hash | The alert email goes out, as for any new block |
| C. Parse anyway (as today) | Same as switch off | No memory protection, contradicts this item |

Proposal: **A**. The difference is explicit in the payload (`attempts`, `original_storage.status` + `inline_extract: "skipped_cap"`) and is never described as "same behavior". If Parallel also fails, the existing chain continues (Webshare if `proxy_config` is set, otherwise blocked). Under rule 3, the Parallel text is never attached to the stored copy.

Tests:
- X1 switch on, variable unset: `unpdf` is not called for any PDF.
- X2 cap set, file over the cap: `unpdf` not called; Parallel called; the raw row is marked as above; no extraction row.
- X3 file at or under the cap: parsed; extraction recorded.
- X4 switch off with the variable set: the variable is ignored and `unpdf` is called as today.

## 3. Independent reference for the switch-off compatibility test

### Reference
A **frozen copy** of the code before 3a, taken from version control and used only in tests:
- `src/lib/__legacy__/pdf-collect.pre3a.ts` = `pdf-collect.server.ts` at commit `d378197` (2026-10-24, last version before 3a).
- `src/lib/__legacy__/blocked-items.pre3a.ts` = `blocked-items.server.ts` at its last commit before 2026-11-03 13:49. It is needed because 3a changed that file.
- The only edit to the copies is that their imports point to each other. A header comment records the source commit. No production code imports them.

### Harness
Both versions (frozen and current, the current one with the switch off) run against the **same** mocks:
- `fetch` (scripted by URL)
- `unpdf` (a fake document whose text runs through the real `extractText`)
- `parallel-fetch` and `webshare-fallback` (scripted)
- `ops-alerts` (records each `sendCollectionFailureAlert` call)
- a recording Supabase fake (every table, operation and row)

What is compared, with ids and timestamps removed:
- every `raw_items` insert: full row, including `raw_payload`, text, `content_hash`, `collector_version`, `item_status`
- `collection_jobs` insert and update: status and counters `fetched/new/duplicate/failed`, plus the presence or absence of `run_params`
- the order of engine calls: direct → Parallel → Webshare
- `attempts` content
- alert calls and their arguments
- the return value of `runPdfCollection`, including `perTarget`

Scenarios:
- S1 PDF ok
- S2 PDF with no text layer → blocked + alert
- S3 HTML ≥ 1000 chars
- S4 app-shell HTML → Parallel
- S5 403 → Parallel ok
- S6 403 → Parallel empty, no proxy → blocked + alert
- S7 403 → Parallel fails → Webshare ok
- S8 403 → Parallel fails → Webshare fails → blocked
- S9 404 (no retry, not blocked)
- S10 raw insert duplicate (23505)
- S11 blocked duplicate (no re-alert, **and no extra read**)
- S12 several targets mixed (counters)

`mergePdfPages`: the reference is the frozen code's `extractPdfText` (real `unpdf` merge) under the same fake document. A guard test reads `node_modules/unpdf/package.json` and fails when the version is not `1.8.1`, with a message to re-check `mergePdfPages`. No new abstraction layer.

## 4. Changes to the existing 49 tests

- All 49 stay.
- `pdf-collect.server.test.ts`, test "flag off: identical legacy row": its hand-written expected object is **replaced** by the frozen-reference harness S1. The hand-written shape was written by me alongside the new code, so it is not independent.
- `pdf-collect.server.test.ts`, test "flag on: same text and content_hash": the scenario now sets `ORIGINALS_INLINE_EXTRACT_MAX_BYTES` explicitly (otherwise X1 applies and no parsing happens).
- `document-storage.server.test.ts`, size-limit tests: kept, renamed "storage limit" (they protect storage, not download memory). R1–R7 cover the download.
- New tests: R1–R7, X1–X4, S1–S12, and the `unpdf` version guard (about 24).

## 5. Files that would change (after approval)

- `src/lib/document-storage.server.ts`: add `readBodyCapped` and `readInlineExtractCap`.
- `src/lib/pdf-collect.server.ts`: in the enabled branch, capped read, inline cap, Parallel fallback per D1. The switch-off lines stay untouched.
- New `src/lib/__legacy__/pdf-collect.pre3a.ts` and `src/lib/__legacy__/blocked-items.pre3a.ts` (test-only frozen copies).
- New `src/lib/pdf-collect.compat.test.ts` (S1–S12, version guard).
- `src/lib/document-storage.server.test.ts` and `src/lib/pdf-collect.server.test.ts`: as in section 4.
- No new dependency. No schema, Storage or setting change.

## 6. Owner decisions in this review

- D1: text path for PDFs not parsed inline — A (Parallel, recommended), B (blocked) or C (parse anyway).
- D2: default inline cap when unset = 0 (no inline parsing in the enabled path) — confirm.
- D3: a PDF over 52428800 with the switch on: the body is cancelled, so the switch-off result (parsing it) is impossible. It follows D1. Confirm that this visible difference is acceptable.

## 7. Next, after approval of these fixes

Targeted implementation and mock tests only. Then a separate decision on: confirming the deploy environment, a switched-off deploy, and controlled tests.
