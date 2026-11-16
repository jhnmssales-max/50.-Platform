// Reading a call list out of whatever spreadsheet turns up.
//
// The file is somebody else's: a list bought from a data broker, or one
// Joseph assembled in Excel. It will have a header row in some wording nobody
// agreed in advance, blank rows in the middle, a totals row at the bottom,
// phone numbers stored as numbers so Excel has eaten the leading zero, and
// some columns we have no use for. None of that is a reason to make a person
// clean the file up before the computer will read it.
//
// So: guess the columns from the headers, let the caller correct the guess,
// and skip rows that are obviously not companies rather than importing
// rubbish or refusing the whole file.

const ExcelJS = require('exceljs');
const { parse: parseCsv } = require('csv-parse/sync');

// 10,000 rows a month is the expected load; the ceiling is for a file that is
// not what anybody thinks it is.
const MAX_ROWS = 100000;

// Header wordings seen in the wild, lowercased and stripped of everything but
// letters, so "Company Name", "company_name" and "COMPANY-NAME" are one key.
// Order matters inside each list: the earliest match wins, so a sheet with
// both "contact name" and "name" maps each to the right field.
const FIELD_HEADERS = {
  company_name: ['companyname', 'company', 'business', 'businessname', 'dba', 'accountname', 'organization', 'organisation', 'name'],
  contact_name: ['contactname', 'contact', 'owner', 'ownername', 'firstname', 'fullname', 'person'],
  phone: ['phone', 'phonenumber', 'telephone', 'tel', 'mobile', 'cell', 'primaryphone', 'businessphone'],
  email: ['email', 'emailaddress', 'mail', 'contactemail'],
  website: ['website', 'web', 'url', 'site', 'domain', 'webaddress'],
  city: ['city', 'town', 'locality'],
  state: ['state', 'province', 'region', 'st'],
  notes: ['notes', 'note', 'comment', 'comments', 'description', 'detail', 'details'],
};

const normHeader = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z]/g, '');

// A sheet's header row -> which of our fields each column holds.
//
// Taking the best match per FIELD rather than per column: two columns both
// looking like a phone ("phone", "mobile") must not both claim it, and the
// first one wins because that is the order a person reads them in.
function guessColumns(headerRow) {
  const headers = headerRow.map(normHeader);
  const taken = new Set();
  const map = {};
  for (const [field, candidates] of Object.entries(FIELD_HEADERS)) {
    let best = -1;
    let bestRank = Infinity;
    headers.forEach((h, i) => {
      if (!h || taken.has(i)) return;
      const exact = candidates.indexOf(h);
      // An exact header beats a header that merely contains the word, so
      // "phone" wins over "phone notes".
      const rank = exact >= 0 ? exact : candidates.findIndex((c) => h.includes(c)) >= 0
        ? 100 + candidates.findIndex((c) => h.includes(c))
        : Infinity;
      if (rank < bestRank) { bestRank = rank; best = i; }
    });
    if (best >= 0 && bestRank !== Infinity) { map[field] = best; taken.add(best); }
  }
  return map;
}

// Does this row look like column headings rather than a company?
//
// A sheet with no header row at all is common when someone pastes a column of
// names, and treating "Acme Roofing" as a heading would silently drop it.
function looksLikeHeader(row) {
  const cells = row.map(normHeader).filter(Boolean);
  if (!cells.length) return false;
  const known = new Set(Object.values(FIELD_HEADERS).flat());
  const hits = cells.filter((c) => known.has(c) || [...known].some((k) => c.includes(k))).length;
  return hits >= Math.max(1, Math.ceil(cells.length / 2));
}

// Excel stores a phone typed as digits as a NUMBER, which loses the leading
// zero and can arrive as 1.4025550123e9. Keep what a person would recognise.
function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // exceljs rich text, hyperlinks and formula results.
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('').trim();
    if (v.text != null) return String(v.text).trim();
    if (v.hyperlink != null) return String(v.hyperlink).trim();
    if (v.result != null) return cellText(v.result);
    if (v.error) return '';
  }
  return String(v).trim();
}

// A sheet (or CSV) as a plain array of rows of strings.
async function readRows(buffer, filename) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt') || name.endsWith('.tsv')) {
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    const delimiter = name.endsWith('.tsv') ? '\t' : guessDelimiter(text);
    const rows = parseCsv(text, {
      delimiter,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      bom: true,
      to: MAX_ROWS + 5,
    });
    return rows.map((r) => r.map((c) => String(c == null ? '' : c).trim()));
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets.find((w) => w.rowCount > 0) || wb.worksheets[0];
  if (!sheet) return [];
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (rows.length > MAX_ROWS + 5) return;
    const values = [];
    // row.values is 1-based with a hole at index 0.
    const raw = Array.isArray(row.values) ? row.values.slice(1) : [];
    const width = Math.max(raw.length, row.cellCount || 0);
    for (let i = 0; i < width; i += 1) values.push(cellText(raw[i]));
    rows.push(values);
  });
  return rows;
}

// Commas unless the file plainly uses something else. Counted on the first
// few lines only, so one stray semicolon deep in a notes column cannot
// re-interpret the whole file.
function guessDelimiter(text) {
  const head = text.split(/\r?\n/).slice(0, 5).join('\n');
  const count = (ch) => (head.split(ch).length - 1);
  const candidates = [[',', count(',')], [';', count(';')], ['\t', count('\t')], ['|', count('|')]];
  candidates.sort((a, b) => b[1] - a[1]);
  return candidates[0][1] > 0 ? candidates[0][0] : ',';
}

// The whole job: bytes in, companies out, plus what was thrown away and why.
//
// `columns` overrides the guess, as {company_name: 0, phone: 3, ...}, and
// `hasHeader` overrides whether the first row is headings at all. The
// screen shows the guess and lets it be corrected before anything is written,
// because a list imported under the wrong column mapping is far more work to
// undo than to get right the first time.
async function readCallList(buffer, filename, { columns, hasHeader: headerOverride } = {}) {
  const rows = await readRows(buffer, filename);
  if (!rows.length) {
    return { entries: [], skipped: [], columns: {}, headerRow: null, totalRows: 0, truncated: false };
  }

  const first = rows[0];
  // Guessed, unless the screen says otherwise. Both directions matter: a
  // sheet whose first company is called "Contact Lens Supply Co" guesses its
  // way into being a header row, and a sheet headed "A, B, C" guesses its way
  // out of being one. The person looking at the preview can see which.
  const hasHeader = typeof headerOverride === 'boolean' ? headerOverride : looksLikeHeader(first);
  const guessed = hasHeader ? guessColumns(first) : {};
  const map = columns && Object.keys(columns).length ? columns : guessed;

  // No header and no override: assume the first column is the company and
  // make what we can of the rest, which is what a pasted column of names is.
  if (!Object.keys(map).length) map.company_name = 0;

  const body = hasHeader ? rows.slice(1) : rows;
  const truncated = body.length > MAX_ROWS;
  const take = truncated ? body.slice(0, MAX_ROWS) : body;

  const pick = (row, field) => {
    const i = map[field];
    return i === undefined || i === null ? '' : String(row[i] == null ? '' : row[i]).trim();
  };

  const entries = [];
  const skipped = [];
  const seen = new Map(); // normalised company -> the row that claimed it

  take.forEach((row, i) => {
    const lineNo = (hasHeader ? 2 : 1) + i;
    const company = pick(row, 'company_name');
    if (!company) {
      // A blank line between sections, or a trailing total. Not worth
      // reporting one by one, but worth counting.
      if (row.some((c) => c)) skipped.push({ line: lineNo, reason: 'no company name', row: row.slice(0, 4).join(' | ') });
      return;
    }
    const key = company.toLowerCase().replace(/\s+/g, '');
    if (seen.has(key)) {
      skipped.push({ line: lineNo, reason: `same company as line ${seen.get(key)}`, row: company });
      return;
    }
    seen.set(key, lineNo);
    entries.push({
      row_no: entries.length + 1,
      company_name: company.slice(0, 200),
      contact_name: pick(row, 'contact_name').slice(0, 120) || null,
      phone: pick(row, 'phone').slice(0, 50) || null,
      email: pick(row, 'email').slice(0, 200) || null,
      website: pick(row, 'website').slice(0, 300) || null,
      city: pick(row, 'city').slice(0, 120) || null,
      state: pick(row, 'state').slice(0, 60) || null,
      notes: pick(row, 'notes').slice(0, 2000) || null,
    });
  });

  return {
    entries,
    skipped,
    columns: map,
    headerRow: hasHeader ? first : null,
    totalRows: body.length,
    truncated,
  };
}

module.exports = { readCallList, guessColumns, looksLikeHeader, cellText, MAX_ROWS, FIELD_HEADERS };
