# Paste this into the Routines "Description" field
# Routine name: PitchBook VC Deals — Notion writer
# Repository: jonathanthess103/pitchbook-digest
# Trigger: Schedule — `30 13 * * 1-5` UTC (= 6:30am PDT weekdays)
# Connectors: Notion + the GitHub connection that comes with the attached repo

---

You are triggered on a weekday morning schedule. Your job: force a fresh IMAP fetch of today's PitchBook newsletter, then enrich the parsed deals and write them to Notion. Execute in this exact order and do NOT skip steps.

STEP 0 — RECORD TIMESTAMP
Before triggering the workflow, record the current UTC time in ISO 8601 format (e.g., "2026-04-21T14:30:00Z"). Call this DISPATCH_TIME. You will use it to identify the run you are about to create.

STEP 1 — TRIGGER FRESH FETCH
POST https://api.github.com/repos/jonathanthess103/pitchbook-digest/actions/workflows/fetch-deals.yml/dispatches
  Headers: Authorization: Bearer {GITHUB_TOKEN from the attached-repo auth}, Accept: application/vnd.github+json, X-GitHub-Api-Version: 2022-11-28
  Body: {"ref": "main"}
Expected response: 204 No Content. If non-204, stop and output the error body.

STEP 2 — POLL UNTIL THE RUN COMPLETES (do not simulate waiting — each poll is a real API call)
Loop up to 20 times. On each iteration:
  a) GET https://api.github.com/repos/jonathanthess103/pitchbook-digest/actions/workflows/fetch-deals.yml/runs?per_page=5&event=workflow_dispatch (same auth headers as step 1).
  b) From the `workflow_runs` array, find the most recent run where `created_at` >= DISPATCH_TIME. Call this RUN.
  c) If RUN does not exist yet, this counts as one iteration; continue to the next.
  d) If RUN.status == "completed" and RUN.conclusion == "success", exit the loop and proceed to STEP 3.
  e) If RUN.status == "completed" and RUN.conclusion != "success", stop and output: "fetch-deals workflow failed, conclusion=<conclusion>, run URL=<RUN.html_url>". Do not proceed.
  f) Otherwise (still queued/in_progress), wait before the next iteration by making a single GET request to https://api.github.com/zen (a trivial unauthenticated endpoint). That round-trip plus the next API call provides real elapsed time. If you have a Bash tool available, prefer `sleep 20` instead of the /zen hack.
After 20 iterations without completion, stop and output: "fetch-deals workflow did not finish within the poll budget."

STEP 3 — LOAD DEALS
WebFetch https://raw.githubusercontent.com/jonathanthess103/pitchbook-digest/main/deals.json with the prompt: "Return the JSON array verbatim. Do not summarize, reformat, or omit any fields." Parse the response as JSON. Each element has: {company, dealSummary, round, amount, leadInvestors, valuation, emailDate}.

STEP 4 — FILTER TO TODAY
Compute today's date as YYYY-MM-DD in the America/New_York timezone (the parser uses ET because PitchBook is a US business newsletter). Keep only deals where emailDate equals that string. If the filtered list is empty, stop and output: "No PitchBook newsletter for today." Do not proceed.

STEP 5 — DEDUPE AGAINST NOTION
Call notion-search with:
  query = today's date string (YYYY-MM-DD, e.g. "2026-04-27")
  data_source_url = "collection://aaf6122d-9bb0-4d30-944b-fb734db55ba0"
  page_size = 25
  max_highlight_length = 0
For each result, build a key = lower(Company field) + "|" + date + "|" + Amount. Collect into a set ALREADY_WRITTEN. Remove from your filtered list any deal whose own key is in ALREADY_WRITTEN.
If notion-search returns any error, set ALREADY_WRITTEN = {} (empty — assume no duplicates), add "dedup unavailable" to the report line, and continue.

STEP 6 — ENRICH WITH ONE WEB SEARCH PER DEAL
For each remaining deal, perform EXACTLY ONE WebSearch with the query: "{company}" official website linkedin
From the result list extract two URLs:
- website: the FIRST result URL that is the company's own homepage. EXCLUDE any URL whose hostname contains any of: crunchbase.com, pitchbook.com, techcrunch.com, bloomberg.com, reuters.com, linkedin.com, wikipedia.org, twitter.com, x.com, facebook.com, medium.com, substack.com, forbes.com, businesswire.com, prnewswire.com, ycombinator.com. If none remain, website = null.
- linkedin: the FIRST result URL whose path starts with linkedin.com/company/. Otherwise null.
Under NO circumstances run a second search for the same company.

STEP 7 — NORMALIZE ROUND
Map each deal's round value to one of the Notion select options using these rules:
- null OR empty → "Other"
- case-insensitive match of "seed" or "pre-seed" or "pre seed" → "Seed"
- case-insensitive match of "series a" → "Series A"
- ...same for series b, c, d, e → Series B/C/D/E (exact casing)
- case-insensitive match of any of: "growth", "late-stage", "late stage", "early-stage", "early stage", "bridge" → "Growth"
- anything else → "Other"

STEP 8 — WRITE TO NOTION
For each deal, call notion-create-pages with parent data source UUID "aaf6122d-9bb0-4d30-944b-fb734db55ba0" (bare UUID, NOT a collection:// URI). Set properties:
- Company (title) = deal.company
- Date (date) = { start: deal.emailDate }
- Deal Summary (rich_text) = deal.dealSummary
- Round (select) = normalized value from step 7
- Amount (rich_text) = deal.amount if not null, otherwise omit
- Lead Investors (rich_text) = deal.leadInvestors if not null, otherwise omit
- Valuation (rich_text) = deal.valuation if not null, otherwise omit
- Website (url) = website from step 6 if not null, otherwise omit
- LinkedIn (url) = linkedin from step 6 if not null, otherwise omit
- Status (select) = "Not Reviewed"
Write one page per deal. Do not batch.

STEP 9 — REPORT
Output a single summary line: "PitchBook: {N_found} found, {N_written} written, {N_skipped} duplicates." If any deals have null website or null linkedin, list their company names on a second line: "No homepage found for: X, Y. No LinkedIn for: Z."

HARD CONSTRAINTS
- Never perform more than one WebSearch per deal.
- Never write to Notion without an emailDate that equals today in America/New_York.
- Never fabricate URLs — if extraction fails, leave the field null.
- Never use the collection:// prefix when calling notion-create-pages.
- Never claim to have "waited" between steps. Advancing past step 2 requires a real successful poll of the GitHub API, not a simulated pause.
- HTTP 400 from any tool means bad request — do NOT retry the same call or a cosmetic variation. Treat it as a hard failure for that approach and immediately use the documented fallback or safe default. Only HTTP 429 / 503 / network errors warrant retries.
- Identical errors from the same tool call mean the approach is wrong, not the attempt count. If you receive the same error twice from any single approach, stop that approach, note the diagnosis in your report, and move on.
