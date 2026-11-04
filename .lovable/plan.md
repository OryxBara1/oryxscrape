# Runbook — one real test of original-file storage (3a)

Runbook only. Nothing here has been run. Labels: [V] = verified directly in this session, [E] = reported from earlier work, [N] = not tested yet.

## 1. Source and file
- File: `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf`. It's a public W3C test PDF with no sensitive content and a text layer, about 13 KB. [N] I haven't checked the size, hash or how it is served.
- Size and hash: before R4 the owner downloads the file once on their own machine (`curl -sSL -o d.pdf <URL>; wc -c d.pdf; shasum -a 256 d.pdf`) and records both values. If the size is outside 5–100 KB, stop.
- New test source, fixed id `3a0e5ca1-0000-4000-8000-0000000003a1`, name `TEST 3a originals — do not schedule`, domain `www.w3.org`, start_url = the file, method `http`, `is_active=true`, `schedule_enabled=false`, `proxy_config=NULL`, notes `TEST:phase1b-3a`.

## 2. Configuration (owner sets these in Secrets)
- `ORIGINALS_STORAGE_MODE=test` and `ORIGINALS_INLINE_EXTRACT_MAX_BYTES=1048576` (local extraction). Both are absent today. [V] I read this in the code, which treats an absent value as off and a cap of 0.
- Why this source won't run on a schedule:
  - In `test` mode files are stored only for manual runs that ask for it. [V] I read this in the code.
  - The scheduled caller never asks for it. [V] I read this in the code.
  - The generic scheduler only picks sources with `schedule_enabled=true`. [V] I read this in the code.
  - The 9 active cron jobs call only fixed country routes, and none calls the generic route. [V] I queried this.
- Manual call: run `startCollectionJob` once with `{sourceId, documents:[{url}], storeOriginals:true}`. The screens never send `storeOriginals` [V], so the agent makes this call directly with the owner's staff session after the owner authorizes it. [N] I haven't checked that this call reaches the environment where the secret is set. The job's `run_params.originals` will show whether it did.

## 3. Maximum expected cost
- Normal path: one free download from w3.org, one upload plus one check (about 26 KB) to the private storage folder, and about 10 database writes. That's practically no cost. [N]
- Worst case: 1 paid Parallel call if the direct download fails or doesn't return a PDF, plus 1 alert email if that also fails. No Webshare, because the source has no proxy. [V] I read this in the code. [N] I haven't checked Parallel's price per call.
- Alternative with the cap set to 0: Parallel is always called once. The text then comes from Parallel, with no local extraction record. [V] I read this in the code.

## 4. Expected records
- Always created: 1 source, 1 job (`succeeded`), 1 raw_item, 1 `document_copies` (`verified`), 1 Storage object at `sha256/<hh>/<hash>`, 1 sighting and 1 extraction (`unpdf@1.8.1`, text stored inline). [N]
- Only on the fallback path: a blocked record and an alert email.
- Never created: legal documents, versions, approvals or normalized items.
- Starting point: copies, sightings, extractions and stored files are all 0. raw_items is 1210 and jobs is 282. Two old jobs are still running and won't be touched. [V] I queried this.

## 5. Checking the file and hash
- Before the run: count rows in every affected table, and record the state of the two old jobs.
- After the run:
  - The job status and `run_params.originals`.
  - The copy's `file_sha256` must equal `sha256:<owner hash>` and its size must match.
  - The file path must match the hash, and there must be exactly 1 stored file.
  - The sighting and extraction must point to the same copy, raw_item and job.
  - All new rows must belong to the test source, and earlier rows must be unchanged.
- Independent check: the owner downloads the stored file through a 300-second signed link and compares its SHA-256.
- Stop with no retry if any of these happens: a memory error or timeout, a hash or size mismatch, an unexpected write, an unplanned Parallel call, or originals data appearing on any other job.

## 6. Back to off
- The owner deletes both secrets, which turns storage off. [V] I read this in the code.
- The next job of any other source must have no `run_params.originals`. This is a passive check, so no run is started for it.
- Keep the source, job, raw_item, copy, sighting and extraction ids, the file path and the hash. Nothing gets deleted.
- After this, the 3a pilot closes with its documented limitations, and work moves to the discovery queue.

## Steps (owner approves each one)
R1 owner gets the hash → R2 counts before the run and create the source → R3 owner sets the secrets → R4 one manual call → R5 checks → R6 back to off.
