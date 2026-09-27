# Backlog strategy, guided review and "Capy" — analysis and plan

## What the database shows today
- Group A (`item_status = 'collected'`): 265 raw items, **all 265 already have a normalized item**, so all of them already appear on the Collected items page.
- Group B (`item_status` empty): **319** raw items, not 317. Only 77 of them have a normalized item (the EUR-Lex set). The other 242 (Netherlands, piste, Brazil, old Croatia and others) **cannot be reviewed at all right now**, because every review screen works on normalized items.
- `item_status` is a fixed list of allowed values in the database: collected, failed, pending, superseded.

## 1. Backlog strategy — my opinion
I agree with the strategy, with one change: **don't add `migration_pending`.**
- Raw items are append-only and locked against edits by design. Marking 319 rows `migration_pending` means breaking that lock, or adding an exception for this one column. Both weaken the guarantee that raw evidence never changes.
- "Empty status" already means "legacy, not checked". Giving it a second name adds no information.
- Better: record the migration audit **outside** the raw row. Add one audit record per domain batch ("checked provenance for Netherlands: 68 OK / 3 missing URL"), and only then normalize those items so they enter review. Raw rows stay untouched.
- If you still want a status value: adding a value to the list is safe and additive. The frontend would only need a label and filter option. The immutability exception is the real cost, not the frontend.

Order: review Group A first. The 77 EUR-Lex items are Group B but already normalized, so they can be reviewed now too. Then audit the other 242 one domain at a time.

## 2a. Is there a review interface today?
Yes, but it's built for experts and split across two areas on one page (Collected items):
- **Triage panel** (top): filters, search, a table, and an eye icon that opens a dialog. The dialog shows the source link, CELEX number, type, date, raw data, country checkboxes and application status. Actions: Save scope, Approve for Exchange, Reject with reason, Reopen, Internal only. Batch reject is also available.
- **Tier matrix** (below): one row per item and per profile, with Review, Reject, Mark eligible and Promote buttons.
- It has no "Skip", no one-item-at-a-time mode, and no guidance. Having two different ways to review on one page is probably what confuses the product owner most.

## 2b. Guided review (new page "Review")
One item at a time, in a queue of unreviewed items. The queue can be narrowed by country or source.
```text
[ 12 of 265 ]  FR · legifrance.gouv.fr · Decree
Title
Source link  [View original]
Preview (summary + first ~2,000 chars of text)
Step hint: "Is this about recreational boating rules?"
[Approve -> AuraMaris queue]  [Reject (reason)]  [Skip]
```
- **Approve** marks the item reviewed and eligible. It then goes to the Exchange page, where it's packaged the same way as today. EU items first ask for countries and application status, the same rule as now.
- **Reject** asks for a short reason from a preset list. It reuses the existing reject action and audit record.
- **Skip** only moves to the next item. It is stored in the browser, not the database.
- **View original** opens the source in a popup, as today.
- Keyboard shortcuts: A (approve), R (reject), S (skip), O (open original).
- Add a link to this page in the menu and make it step 3 of the "?" guide. The existing page stays as the expert view.
- No changes to the database. Everything reuses existing server actions.

## 2c. Capy — feasible, simplest version
Yes, this is feasible. One correction: Capy would **not** use a Supabase Edge Function, because they can't be deployed in this project. It would use a server action inside the app, the same way normalization already calls LogoriOn with the server-held `LOGORION_INTEGRATION_KEY`. No key reaches the browser.

MVP:
- A small side panel on the Review page with a capybara avatar and three suggested questions. It answers about **the current item only**, and the conversation resets when you move to the next item. Nothing is saved.
- A server action loads the item on the server: title, domain, country, tags/concept, curation, and the text trimmed to about 30k characters. It adds a short description of the collection methodology and your question, then sends everything to LogoriOn.
- Answers are shown as formatted text. Errors from LogoriOn appear in the panel. There is no automatic retry.
- Capy only gives advice. It never approves or rejects anything.
- **What you need to provide:** a new prompt template in LogoriOn (e.g. `oryxscrape_capy_v1`) with its prompt ID. I'll draft the template text for you. I also need your list of AuraMaris categories, otherwise Capy can't answer "which category".

## Suggested build order
1. Guided Review page (no database changes).
2. Capy panel, once you give me the LogoriOn prompt ID and category list.
3. Legacy audit tool for Group B, one domain at a time, with audit records (no raw item edits).

## Technical notes
- Queue source: normalized items with verification unreviewed, ordered by collected date. Actions call the existing `setItemReviewState`, `saveItemCuration` and `rejectItems` functions, and detail comes from `getItemDetail`.
- Capy: `src/lib/capy.functions.ts` (staff-only middleware), `src/lib/capy.server.ts` (LogoriOn call with its own prompt ID and feature tag `oryxscrape.capy`). Text is rendered with react-markdown.
- Legacy promotion: a staff action that runs the existing normalization for a domain's raw items with no status, after a provenance check (URL, collected date, hash present). It writes one audit record per batch.
