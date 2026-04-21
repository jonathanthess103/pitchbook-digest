#!/usr/bin/env node
/**
 * pitchbook-digest / fetch-deals.js
 *
 * Connects to Gmail via IMAP, finds PitchBook newsletter(s), extracts the
 * VC DEALS section, and writes structured JSON to deals.json for the Claude
 * scheduled task to enrich and push to Notion.
 *
 * Usage:
 *   node fetch-deals.js            # most recent newsletter only
 *   node fetch-deals.js --backfill # all newsletters in inbox
 */

'use strict';

const Imap = require('imap');
const { simpleParser } = require('mailparser');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const SENDER = 'news-noreply@news.pitchbook.com';
const OUTPUT_FILE = path.join(__dirname, 'deals.json');
const BACKFILL_MODE = process.argv.includes('--backfill');

// ─── IMAP helpers ────────────────────────────────────────────────────────────

function connectImap() {
  return new Imap({
    user: process.env.GMAIL_EMAIL,
    password: process.env.GMAIL_APP_PASSWORD,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
  });
}

function openInbox(imap) {
  return new Promise((resolve, reject) => {
    imap.openBox('INBOX', true, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
}

function searchMessages(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (err, uids) => {
      if (err) reject(err);
      else resolve(uids);
    });
  });
}

function fetchMessage(imap, uid) {
  return new Promise((resolve, reject) => {
    const f = imap.fetch(uid, { bodies: '' });
    const chunks = [];
    f.on('message', (msg) => {
      msg.on('body', (stream) => {
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => {});
      });
      msg.once('attributes', (attrs) => {
        msg._date = attrs.date;
      });
    });
    f.once('end', () => resolve({ raw: Buffer.concat(chunks), date: f._date }));
    f.once('error', reject);
  });
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

const SECTION_PATTERN = /^(VC\s+DEALS?|VENTURE\s+(?:CAPITAL\s+)?DEALS?)/i;
const NEXT_SECTION_PATTERN = /^(PE\s+DEALS?|M&A|EXITS?|FUNDS?|PEOPLE|CHART|STAT|QUOTE|SPONSOR|ADVERTI)/i;

function extractVcDeals(html, emailDate) {
  const $ = cheerio.load(html);

  // Get full document text and find the VC DEALS section boundary
  const fullText = $('body').text().replace(/\s+/g, ' ').trim();

  const sectionMatch = fullText.match(
    /VC\s+DEALS?\s+([\s\S]+?)(?=\s+PE\s+DEALS?|\s+M&A\s+DEALS?|\s+VENTURE\s+DEBT|\s+EXITS?\s+&|\bFrom our sponsor\b|\bAdvertisement\b|$)/i
  );
  if (!sectionMatch) {
    console.warn('  Could not find VC DEALS section in email');
    return [];
  }

  const sectionText = sectionMatch[1].trim();

  // Split the section into individual deals.
  // Deals are separated by ". " or "." before a capital letter.
  // Accumulate sentences until we have one that contains a dollar amount (= complete deal).
  const sentences = sectionText.split(/(?<=\.)\s*(?=[A-Z])/);
  const dealTexts = [];
  let buffer = '';

  for (const sentence of sentences) {
    buffer = buffer ? `${buffer} ${sentence.trim()}` : sentence.trim();
    if (/[$€£¥][\d,.]+\s*(million|billion)/i.test(buffer)) {
      dealTexts.push(buffer);
      buffer = '';
    }
  }
  if (buffer && /[$€£¥][\d,.]+\s*(million|billion)/i.test(buffer)) {
    dealTexts.push(buffer);
  }

  return dealTexts.map((text) => parseDeal(text, emailDate)).filter(Boolean);
}

const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
function formatEtDate(d) { return ET_DATE_FMT.format(d); }

const AMOUNT_RE = /([€£¥$])([\d,.]+)\s*(million|billion|M\b|B\b)/i;
const ROUND_RE = /\b(Series\s+[A-F]|Seed|Pre-Seed|Pre-seed|Growth|Late[\s-]stage|Early[\s-]stage|Bridge)\b/i;
const LED_BY_RE = /(?:led\s+by|from\s+investors?\s+(?:including|such\s+as|led\s+by))\s+(?:investors?\s+including\s+)?(.+?)(?:\s+at\s+a\s+\$|\s+at\s+a\s+valuation|\.|,\s+bringing|$)/i;
const FROM_RE = /(?:raised?|received?|secured?)\s+\$[\d,.]+ \w+ (?:\w+ )?from\s+([A-Z][A-Za-z\s,]+?(?:\s+and\s+[A-Z][A-Za-z\s]+?)?)(?:\s+at\s+a|\s+in\s+a|\s+to\s+|\.|$)/;
const VALUATION_RE = /at\s+a\s+(\$[\d,.]+\s*(?:million|billion))\s+valuation/i;

// Words used to categorise companies — stripped as prefixes
const TYPE_WORDS = 'fintech|startup|company|firm|developer|provider|platform|maker|operator|group|insurer|lender|bank|venture';
const PREFIX_RE = new RegExp(
  `^(?:[\\w-]+-based\\s+)?(?:\\w+\\s+)*(?:${TYPE_WORDS})\\s+`,
  'i'
);

function cleanCompany(raw) {
  return raw
    .replace(/,\s+(?:a|an|the|which|that|who)\s+.+$/i, '') // strip appositives/clauses
    .replace(PREFIX_RE, '')                                  // strip descriptor prefix
    .replace(/^[\w-]+-based\s+/i, '')                       // strip any remaining "X-based "
    .replace(/,\s*$/, '')
    .trim();
}

function parseDeal(text, emailDate) {
  const verbMatch = text.match(/^(.+?)\s+(?:is\s+in\s+talks?\s+to\s+(?:raise|secure)|(?:is\s+)?(raised?|raising|secured?|securing|closed?|closing|announced?|received?|complet(?:ed|ing)|brings?\s+in|plans?\s+to\s+raise))\b/i);
  const company = verbMatch ? cleanCompany(verbMatch[1]) : null;
  if (!company) return null;

  const amountMatch = text.match(AMOUNT_RE);
  const roundMatch = text.match(ROUND_RE);
  const ledByMatch = text.match(LED_BY_RE) || text.match(FROM_RE);
  const valuationMatch = text.match(VALUATION_RE);

  const rawInvestors = ledByMatch ? ledByMatch[1].replace(/\s+and\s+/g, ', ').trim() : null;

  return {
    company: company.replace(/,\s*$/, '').trim(),
    dealSummary: text,
    round: roundMatch ? roundMatch[1].trim() : null,
    amount: amountMatch ? `${amountMatch[1]}${amountMatch[2]} ${amountMatch[3].toLowerCase()}` : null,
    leadInvestors: rawInvestors ? rawInvestors.replace(/,\s*\w+\s+reported\.?$/i, '').trim() : null,
    valuation: valuationMatch ? valuationMatch[1].trim() : null,
    emailDate: formatEtDate(emailDate ? new Date(emailDate) : new Date()),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.GMAIL_EMAIL || !process.env.GMAIL_APP_PASSWORD) {
    console.error('ERROR: Set GMAIL_EMAIL and GMAIL_APP_PASSWORD in .env');
    process.exit(1);
  }

  const imap = connectImap();

  await new Promise((resolve, reject) => {
    imap.once('ready', resolve);
    imap.once('error', reject);
    imap.connect();
  });

  await openInbox(imap);

  const criteria = [['FROM', SENDER]];
  const uids = await searchMessages(imap, criteria);

  if (uids.length === 0) {
    console.log('No PitchBook newsletters found in inbox.');
    imap.end();
    return;
  }

  const toProcess = BACKFILL_MODE ? uids : [uids[uids.length - 1]];
  console.log(`Processing ${toProcess.length} newsletter(s)...`);

  const allDeals = [];

  for (const uid of toProcess) {
    try {
      const { raw, date } = await fetchMessage(imap, uid);
      const parsed = await simpleParser(raw);
      const html = parsed.html || parsed.textAsHtml || '';
      const emailDate = parsed.date || date;

      const deals = extractVcDeals(html, emailDate);
      console.log(`  [${emailDate ? new Date(emailDate).toDateString() : 'unknown date'}] Found ${deals.length} VC deal(s)`);
      allDeals.push(...deals);
    } catch (err) {
      console.warn(`  Skipping uid ${uid}: ${err.message}`);
    }
  }

  imap.end();

  // Deduplicate by company+date
  const seen = new Set();
  const unique = allDeals.filter((d) => {
    const key = `${d.company.toLowerCase()}|${d.emailDate}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(unique, null, 2));
  console.log(`\nWrote ${unique.length} deal(s) to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
