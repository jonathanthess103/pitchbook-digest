# Paste this into the Routines "Description" field
# Routine name: PitchBook VC Deals — Notion writer
# Repository: jonathanthess103/pitchbook-digest
# Trigger: Schedule — `30 13 * * 1-5` UTC (= 6:30am PDT weekdays)
# Connectors: Notion + the GitHub connection that comes with the attached repo

---

You are triggered on a weekday morning schedule. Your job: force a fresh IMAP fetch of today's PitchBook newsletter, then enrich the parsed deals and write them to Notion. Execute in this exact order and do NOT skip steps.

STEP 0 — TRIGGER FRESH FETCH
The repository has a GitHub Actions workflow named `fetch-deals.yml` that reads the PitchBook email via IMAP and commits today's `deals.json`. Trigger it NOW via the GitHub API:
  POST https://api.github.com/repos/jonathanthess103/pitchbook-digest/actions/workflows/fetch-deals.yml/dispatches
  Headers: Authorization: Bearer {GITHUB_TOKEN_from_attached_repo_auth}, Accept: application/vnd.github+json, X-GitHub-Api-Version: 2022-11-28
  Body: {"ref": "main"}
Expected response: 204 No Content. If you receive any non-204 response, stop and output the error body.

STEP 1 — WAIT 5 MINUTES
Pause for 300 seconds. This allows the GitHub Action to complete its IMAP fetch and commit an updated `deals.json` to `main`. Do NOT proceed early.

STEP 2 — LOAD DEALS
WebFetch https://raw.githubusercontent.com/jonathanthess103/pitchbook-digest/main/deals.json with the prompt: "Return the JSON array verbatim. Do not summarize, reformat, or omit any fields." Parse the response as JSON. Each element has: {company, dealSummary, round, amount, leadInvestors, valuation, emailDate}.

STEP 3 — FILTER TO TODAY
Compute today's date as YYYY-MM-DD in the America/New_York timezone (the parser uses ET because PitchBook is a US business newsletter). Keep only deals where emailDate equals that string. If the filtered list is empty, stop and output: "No PitchBook newsletter for today." Do not proceed.

STEP 4 — DEDUPE AGAINST NOTION
Call notion-query-data-sources with data_source_id "aaf6122d-9bb0-4d30-944b-fb734db55ba0" and a filter that the Date property equals today. For each result, build a key = lower(Company) + "|" + emailDate + "|" + Amount. Collect into a set ALREADY_WRITTEN. Remove from your filtered list any deal whose own key is in ALREADY_WRITTEN.

STEP 5 — ENRICH WITH ONE WEB SEARCH PER DEAL
For each remaining deal, perform EXACTLY ONE WebSearch with the query: "{company}" official website linkedin
From the result list extract two URLs:
- website: the FIRST result URL that is the company's own homepage. EXCLUDE any URL whose hostname contains any of: crunchbase.com, pitchbook.com, techcrunch.com, bloomberg.com, reuters.com, linkedin.com, wikipedia.org, twitter.com, x.com, facebook.com, medium.com, substack.com, forbes.com, businesswire.com, prnewswire.com, ycombinator.com. If none remain, website = null.
- linkedin: the FIRST result URL whose path starts with linkedin.com/company/. Otherwise null.
Under NO circumstances run a second search for the same company.

STEP 6 — NORMALIZE ROUND
Map each deal's round value to one of the Notion select options using these rules:
- null OR empty → "Other"
- case-insensitive match of "seed" or "pre-seed" or "pre seed" → "Seed"
- case-insensitive match of "series a" → "Series A"
- ...same for series b, c, d, e → Series B/C/D/E (exact casing)
- case-insensitive match of any of: "growth", "late-stage", "late stage", "early-stage", "early stage", "bridge" → "Growth"
- anything else → "Other"

STEP 7 — WRITE TO NOTION
For each deal, call notion-create-pages with parent data source UUID "aaf6122d-9bb0-4d30-944b-fb734db55ba0" (bare UUID, NOT a collection:// URI). Set properties:
- Company (title) = deal.company
- Date (date) = { start: deal.emailDate }
- Deal Summary (rich_text) = deal.dealSummary
- Round (select) = normalized value from step 6
- Amount (rich_text) = deal.amount if not null, otherwise omit
- Lead Investors (rich_text) = deal.leadInvestors if not null, otherwise omit
- Valuation (rich_text) = deal.valuation if not null, otherwise omit
- Website (url) = website from step 5 if not null, otherwise omit
- LinkedIn (url) = linkedin from step 5 if not null, otherwise omit
- Status (select) = "Not Reviewed"
Write one page per deal. Do not batch.

STEP 8 — REPORT
Output a single summary line: "PitchBook: {N_found} found, {N_written} written, {N_skipped} duplicates." If any deals have null website or null linkedin, list their company names on a second line: "No homepage found for: X, Y. No LinkedIn for: Z."

HARD CONSTRAINTS
- Never perform more than one WebSearch per deal.
- Never write to Notion without an emailDate that equals today in America/New_York.
- Never fabricate URLs — if extraction fails, leave the field null.
- Never use the collection:// prefix when calling notion-create-pages.
- Never skip the 5-minute wait in step 1.
