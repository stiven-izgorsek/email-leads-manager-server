import 'dotenv/config';
import fs from 'fs';
import pg from 'pg';
import { decodeCsvBuffer, nameHasEncodingCorruption } from '../src/utils/csvEncoding.js';

const FILES = [
  'C:/Users/Administrator/Downloads/Apollo_Data_20260805065942.csv',
  'C:/Users/Administrator/Downloads/Apollo_Data_20260805105842.csv',
  'C:/Users/Administrator/Downloads/Apollo_Data_20260805091907.csv',
];

const DRY_RUN = process.argv.includes('--dry-run');

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function normalizeHeader(h) {
  return String(h || '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

function normalizeLinkedIn(raw) {
  if (!raw) return '';
  let s = String(raw).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const m = s.match(/linkedin\.com\/in\/([^/?#]+)/);
  if (m) return m[1].replace(/\/+$/, '');
  return s.replace(/\/+$/, '');
}

function normalizeEmail(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase();
}

/** ASCII skeleton for comparing corrupted vs correct names. */
function companyMatchKey(name) {
  return String(name || '')
    .replace(/[\uFFFD\u0080-\u009F?]+/g, '')
    .replace(/[^\x00-\x7F]+/g, '') // drop letters with diacritics entirely
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function hasSpecialLetters(name) {
  return /[\u0100-\u024F]/.test(String(name || ''));
}

/**
 * Apollo EE CSV bytes sometimes use 0x84 („) where ä belonged, and 0x8E (Ž) where Õ belonged.
 * Oš via 0x9A is already correct under windows-1250.
 */
function polishApolloName(name, { estonianHints = false } = {}) {
  if (!name) return name;
  let s = String(name);
  // 0xB3 often used as a separator (shows as ł under CP1250)
  s = s.replace(/\s+ł\s+/g, ' – ');
  s = s.replace(/(\p{L})„„(\p{L})/gu, '$1ää$2');
  s = s.replace(/(\p{L})„(\p{L})/gu, '$1ä$2');
  if (estonianHints) {
    // LŽVI → LÕVI style (rare Ž mid-token in these EE exports)
    s = s.replace(/(\p{L})Ž(\p{L})/gu, '$1Õ$2');
    // šhisraha → Ühisraha (leading š stand-in for Ü before a word)
    s = s.replace(/^š(?=[a-z]{4,})/u, 'Ü');
    s = s.replace(/(\s)š(?=[a-z]{4,})/gu, '$1Ü');
  }
  return s;
}

function parseCsvFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const { text, encoding } = decodeCsvBuffer(buf);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { encoding, rows: [] };

  const headers = parseCsvLine(lines[0]).map(normalizeHeader);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      if (values[idx]) row[h] = values[idx];
    });
    rows.push(row);
  }
  return { encoding, rows };
}

function getField(row, ...names) {
  for (const n of names) {
    const key = normalizeHeader(n);
    if (row[key]) return String(row[key]).trim();
  }
  return '';
}

function shouldUpgradeName(existing, incoming) {
  if (!incoming) return false;
  if (existing === incoming) return false;
  if (nameHasEncodingCorruption(existing)) return true;
  if (hasSpecialLetters(incoming) && !hasSpecialLetters(existing || '')) {
    return companyMatchKey(existing) === companyMatchKey(incoming);
  }
  return false;
}

const csvEntries = [];
for (const file of FILES) {
  const { encoding, rows } = parseCsvFile(file);
  const estonianHints = /20260805105842/.test(file);
  console.log(`Parsed ${file.split('/').pop()}: encoding=${encoding}, rows=${rows.length}`);
  for (const row of rows) {
    let companyName = getField(row, 'companyname', 'company', 'organization', 'organisation');
    let firstName = getField(row, 'firstname', 'first_name') || null;
    let lastName = getField(row, 'lastname', 'last_name') || null;
    companyName = companyName ? polishApolloName(companyName, { estonianHints }) : '';
    firstName = firstName ? polishApolloName(firstName, { estonianHints }) : null;
    lastName = lastName ? polishApolloName(lastName, { estonianHints }) : null;
    const email = normalizeEmail(getField(row, 'email', 'workemail'));
    const linkedin = normalizeLinkedIn(getField(row, 'linkedinurl', 'linkedin', 'personlinkedinurl'));
    if (!companyName && !firstName && !lastName) continue;
    if (
      !hasSpecialLetters(companyName) &&
      !hasSpecialLetters(firstName) &&
      !hasSpecialLetters(lastName)
    ) {
      continue;
    }
    csvEntries.push({
      companyName: companyName || null,
      email: email || null,
      linkedin: linkedin || null,
      firstName,
      lastName,
      source: file.split('/').pop(),
    });
  }
}

console.log(`CSV rows with special letters: ${csvEntries.length}`);
console.log(
  'Sample companies:',
  [...new Set(csvEntries.map((e) => e.companyName).filter(Boolean))].slice(0, 25)
);

const byEmail = new Map();
const byLinkedin = new Map();
for (const e of csvEntries) {
  if (e.email) {
    const prev = byEmail.get(e.email);
    if (!prev || (e.companyName && hasSpecialLetters(e.companyName))) byEmail.set(e.email, e);
  }
  if (e.linkedin) {
    const prev = byLinkedin.get(e.linkedin);
    if (!prev || (e.companyName && hasSpecialLetters(e.companyName))) byLinkedin.set(e.linkedin, e);
  }
}

const client = new pg.Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_NAME || 'email_leads_manager',
});
await client.connect();

// Load candidate DB rows: corrupted markers OR match keys from CSV specials
const csvKeys = [
  ...new Set(
    csvEntries
      .filter((e) => e.companyName && hasSpecialLetters(e.companyName))
      .map((e) => companyMatchKey(e.companyName))
      .filter(Boolean)
  ),
];

const dbRows = await client.query(`
  SELECT id, email, linkedin, "firstName", "lastName", "companyName"
  FROM client
  WHERE "deletedAt" IS NULL
`);
console.log(`Loaded ${dbRows.rows.length} clients from DB`);

const corruptedCount = dbRows.rows.filter(
  (r) =>
    nameHasEncodingCorruption(r.companyName) ||
    nameHasEncodingCorruption(r.firstName) ||
    nameHasEncodingCorruption(r.lastName)
).length;
console.log(`DB rows with corruption markers: ${corruptedCount}`);

const dbByEmail = new Map();
const dbByLinkedin = new Map();
const dbByCompanyKey = new Map(); // key -> rows[]
for (const row of dbRows.rows) {
  const email = normalizeEmail(row.email);
  const linkedin = normalizeLinkedIn(row.linkedin);
  if (email) dbByEmail.set(email, row);
  if (linkedin) dbByLinkedin.set(linkedin, row);
  const key = companyMatchKey(row.companyName);
  if (key && csvKeys.includes(key)) {
    if (!dbByCompanyKey.has(key)) dbByCompanyKey.set(key, []);
    dbByCompanyKey.get(key).push(row);
  }
}

const updates = [];
const seenIds = new Set();

function queueUpdate(row, csv) {
  if (!row || seenIds.has(row.id)) return;
  const patch = {};
  if (shouldUpgradeName(row.companyName, csv.companyName)) {
    patch.companyName = csv.companyName;
  }
  if (shouldUpgradeName(row.firstName, csv.firstName)) {
    patch.firstName = csv.firstName;
  }
  if (shouldUpgradeName(row.lastName, csv.lastName)) {
    patch.lastName = csv.lastName;
  }
  if (!Object.keys(patch).length) return;
  seenIds.add(row.id);
  updates.push({
    id: row.id,
    email: row.email,
    linkedin: row.linkedin,
    from: {
      companyName: row.companyName,
      firstName: row.firstName,
      lastName: row.lastName,
    },
    to: patch,
    source: csv.source,
  });
}

// Primary: match CSV specials -> DB by email / linkedin
for (const csv of csvEntries) {
  const row =
    (csv.email && dbByEmail.get(csv.email)) ||
    (csv.linkedin && dbByLinkedin.get(csv.linkedin)) ||
    null;
  if (row) queueUpdate(row, csv);
}

// Fallback: corrupted DB company names matching CSV company ASCII skeleton
const csvByCompanyKey = new Map();
for (const csv of csvEntries) {
  if (!csv.companyName || !hasSpecialLetters(csv.companyName)) continue;
  const key = companyMatchKey(csv.companyName);
  if (!key) continue;
  if (!csvByCompanyKey.has(key)) csvByCompanyKey.set(key, csv);
}
for (const row of dbRows.rows) {
  if (!nameHasEncodingCorruption(row.companyName) && hasSpecialLetters(row.companyName)) continue;
  const key = companyMatchKey(row.companyName);
  const csv = key && csvByCompanyKey.get(key);
  if (csv) queueUpdate(row, csv);
}

console.log(`\nPlanned updates: ${updates.length}${DRY_RUN ? ' (dry-run)' : ''}`);
const connectUps = updates.filter((u) => /connect\s*up/i.test(u.from.companyName || '') || /connect\s*up/i.test(u.to.companyName || ''));
console.log('Connect Up updates:', connectUps.length, connectUps.slice(0, 3));
for (const u of updates.slice(0, 40)) {
  console.log({
    email: u.email,
    company: u.to.companyName ? `${u.from.companyName}  =>  ${u.to.companyName}` : undefined,
    first: u.to.firstName ? `${u.from.firstName}  =>  ${u.to.firstName}` : undefined,
    last: u.to.lastName ? `${u.from.lastName}  =>  ${u.to.lastName}` : undefined,
    source: u.source,
  });
}
if (updates.length > 40) console.log(`... and ${updates.length - 40} more`);

if (!DRY_RUN && updates.length) {
  let applied = 0;
  for (const u of updates) {
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(u.to)) {
      sets.push(`"${k}" = $${i++}`);
      vals.push(v);
    }
    sets.push(`"updatedAt" = NOW()`);
    vals.push(u.id);
    await client.query(`UPDATE client SET ${sets.join(', ')} WHERE id = $${i}`, vals);
    applied += 1;
  }
  console.log(`Applied ${applied} updates.`);
} else if (!DRY_RUN) {
  console.log('No updates to apply.');
}

await client.end();
