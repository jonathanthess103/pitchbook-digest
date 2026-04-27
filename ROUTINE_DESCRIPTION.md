# HOW THIS FILE WORKS (read before editing)
#
# The SOURCE OF TRUTH for the routine is the text in the Routines instruction
# box in the platform — not this file. This file exists so Claude can read and
# edit the routine instructions in a normal git workflow.
#
# Any time a change is made to this file, Claude must ALSO paste the revised
# instruction text (everything below the --- line) into the chat so the user
# can copy it into the Routines platform.
#
# Routine name: PitchBook VC Deals — Notion writer
# Repository:   jonathanthess103/pitchbook-digest
# Trigger:      Schedule — `30 13 * * 1-5` UTC (= 6:30am PDT weekdays)
# Connectors:   Notion + the GitHub connection that comes with the attached repo

---

You are triggered on a weekday morning schedule. The fetch-deals GitHub Actions workflow already runs automatically at 12:00, 12:30, and 13:00 UTC — well before this routine fires at 13:30 UTC — so deals.json is already up to date. Your job: load the parsed deals, enrich them, and write them to Notion. Execute in this exact order and do NOT skip steps.

STEP 1 — LOAD DEALS
WebFetch https://raw.githubusercontent.com/jonathanthess103/pitchbook-digest/main/deals.json with the prompt: "Return the JSON array verbatim. Do not summarize, reformat, or omit any fields." Parse the response as JSON. Each element has: {company, dealSummary, round, amount, leadInvestors, valuation, emailDate}.

STEP 2 — FILTER TO TODAY
Compute today's date as YYYY-MM-DD in the America/New_York timezone (the parser uses ET because PitchBook is a US business newsletter). Keep only deals where emailDate equals that string. If the filtered list is empty, stop and output: "No PitchBook newsletter for today." Do not proceed.

STEP 3 — DEDUPE AGAINST NOTION
Call notion-search with:
  query = today's date string (YYYY-MM-DD, e.g. "2026-04-27")
  data_source_url = "collection://aaf6122d-9bb0-4d30-944b-fb734db55ba0"
  page_size = 25
  max_highlight_length = 0
For each result, build a key = lower(Company field) + "|" + date + "|" + Amount. Collect into a set ALREADY_WRITTEN. Remove from your filtered list any deal whose own key is in ALREADY_WRITTEN.
If notion-search returns any error, set ALREADY_WRITTEN = {} (empty — assume no duplicates), add "dedup unavailable" to the report line, and continue.

STEP 4 — ENRICH WITH ONE WEB SEARCH PER DEAL
For each remaining deal, perform EXACTLY ONE WebSearch with the query: "{company}" official website linkedin
From the result list extract two URLs:
- website: the FIRST result URL that is the company's own homepage. EXCLUDE any URL whose hostname contains any of: crunchbase.com, pitchbook.com, techcrunch.com, bloomberg.com, reuters.com, linkedin.com, wikipedia.org, twitter.com, x.com, facebook.com, medium.com, substack.com, forbes.com, businesswire.com, prnewswire.com, ycombinator.com. If none remain, website = null.
- linkedin: the FIRST result URL whose path starts with linkedin.com/company/. Otherwise null.
Under NO circumstances run a second search for the same company.

STEP 5 — NORMALIZE ROUND
Map each deal's round value to one of the Notion select options using these rules:
- null OR empty → "Other"
- case-insensitive match of "seed" or "pre-seed" or "pre seed" → "Seed"
- case-insensitive match of "series a" → "Series A"
- ...same for series b, c, d, e → Series B/C/D/E (exact casing)
- case-insensitive match of any of: "growth", "late-stage", "late stage", "early-stage", "early stage", "bridge" → "Growth"
- anything else → "Other"

STEP 6 — WRITE TO NOTION
For each deal, call notion-create-pages with parent data source UUID "aaf6122d-9bb0-4d30-944b-fb734db55ba0" (bare UUID, NOT a collection:// URI). Set properties:
- Company (title) = deal.company
- Date (date) = { start: deal.emailDate }
- Deal Summary (rich_text) = deal.dealSummary
- Round (select) = normalized value from step 5
- Amount (rich_text) = deal.amount if not null, otherwise omit
- Lead Investors (rich_text) = deal.leadInvestors if not null, otherwise omit
- Valuation (rich_text) = deal.valuation if not null, otherwise omit
- Website (url) = website from step 4 if not null, otherwise omit
- LinkedIn (url) = linkedin from step 4 if not null, otherwise omit
- Status (select) = "Not Reviewed"
Write one page per deal. Do not batch.

STEP 7 — REPORT
Output a single summary line: "PitchBook: {N_found} found, {N_written} written, {N_skipped} duplicates." If any deals have null website or null linkedin, list their company names on a second line: "No homepage found for: X, Y. No LinkedIn for: Z."

HARD CONSTRAINTS
- Never perform more than one WebSearch per deal.
- Never write to Notion without an emailDate that equals today in America/New_York.
- Never fabricate URLs — if extraction fails, leave the field null.
- Never use the collection:// prefix when calling notion-create-pages.
- HTTP 400 from any tool means bad request — do NOT retry the same call or a cosmetic variation. Treat it as a hard failure for that approach and immediately use the documented fallback or safe default. Only HTTP 429 / 503 / network errors warrant retries.
- Identical errors from the same tool call mean the approach is wrong, not the attempt count. If you receive the same error twice from any single approach, stop that approach, note the diagnosis in your report, and move on.
