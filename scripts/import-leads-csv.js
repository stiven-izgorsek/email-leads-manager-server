/**
 * Import leads from a CSV file (e.g. exported via GET /api/leads/download-new-csv).
 *
 * Usage:
 *   npm run import:leads -- path/to/leads.csv
 *   npm run import:leads -- path/to/leads.csv --update
 *
 * --update  If a lead with the same email exists (DB or earlier CSV row), merge non-empty CSV fields into it.
 *           Without --update, duplicate emails are skipped (no second row; same email in CSV only counts once).
 */
import 'reflect-metadata';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import csv from 'csv-parser';
import { AppDataSource } from '../src/config/database.js';
import { Client } from '../src/entities/Client.js';

dotenv.config();

function parseArgs() {
  const args = process.argv.slice(2);
  let filePath = null;
  let updateExisting = false;
  for (const a of args) {
    if (a === '--update' || a === '-u') updateExisting = true;
    else if (!a.startsWith('-')) filePath = a;
  }
  return { filePath, updateExisting };
}

function normalizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const key = String(k).toLowerCase().replace(/\s+/g, '');
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      out[key] = String(v).trim();
    }
  }
  return out;
}

function getField(row, ...names) {
  for (const name of names) {
    const key = name.toLowerCase().replace(/\s+/g, '');
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
      return row[key];
    }
  }
  return null;
}

function parseArrayField(str) {
  if (!str || !String(str).trim()) return null;
  const s = String(str).trim();
  if (s.includes(';')) {
    return s
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean);
  }
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseBool(str) {
  if (str === undefined || str === null || str === '') return undefined;
  const s = String(str).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(s)) return true;
  if (['false', '0', 'no'].includes(s)) return false;
  return undefined;
}

function parseEmployees(str) {
  if (!str || !String(str).trim()) return null;
  const n = parseInt(String(str).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function parseDate(str) {
  if (!str || !String(str).trim()) return null;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeMillionsStatus(raw) {
  if (!raw) return null;
  const normalized = String(raw).trim().toLowerCase();
  if (['good', 'risky', 'bad', 'error'].includes(normalized)) return normalized;
  if (['valid', 'deliverable'].includes(normalized)) return 'good';
  if (['risky-valid', 'riskyvalid', 'risky_deliverable'].includes(normalized)) return 'risky';
  if (['invalid', 'undeliverable', 'blocklisted', 'blocked'].includes(normalized)) return 'bad';
  return null;
}

async function readCsvRows(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => rows.push(normalizeRow(row)))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

function rowToClientPayload(row) {
  const emailRaw = getField(row, 'email');
  if (!emailRaw) return null;

  let linkedin = getField(row, 'linkedin');
  if (linkedin && !linkedin.startsWith('http')) {
    linkedin = `https://${linkedin}`;
  }

  let companyUrl = getField(row, 'companyurl', 'website');
  if (companyUrl && !companyUrl.startsWith('http') && companyUrl.includes('.')) {
    companyUrl = `https://${companyUrl}`;
  }

  const payload = {
    email: emailRaw.toLowerCase().trim(),
    firstName: getField(row, 'firstname') || null,
    lastName: getField(row, 'lastname') || null,
    companyName: getField(row, 'companyname', 'company') || null,
    companyUrl: companyUrl || null,
    linkedin: linkedin || null,
    jobTitle: getField(row, 'jobtitle', 'title') || null,
    location: getField(row, 'location') || null,
    companyLocation: getField(row, 'companylocation') || null,
    status: getField(row, 'status') || 'new',
    industries: parseArrayField(getField(row, 'industries')),
    tech: parseArrayField(getField(row, 'tech')),
    employees: parseEmployees(getField(row, 'employees')),
    contactedBy: parseArrayField(getField(row, 'contactedby', 'assignedto')),
    millionsStatus: normalizeMillionsStatus(getField(row, 'millionsstatus')),
    note: getField(row, 'note') || null,
  };

  const isSent = parseBool(getField(row, 'issent'));
  if (isSent !== undefined) payload.isSent = isSent;

  const isReplied = parseBool(getField(row, 'isreplied'));
  if (isReplied !== undefined) payload.isReplied = isReplied;

  const isFollowup = parseBool(getField(row, 'isfollowup'));
  if (isFollowup !== undefined) payload.isFollowup = isFollowup;

  const lastSent = parseDate(getField(row, 'lastsent'));
  if (lastSent) payload.lastSent = lastSent;

  return payload;
}

async function findExistingByEmail(repo, emailLower) {
  return repo
    .createQueryBuilder('client')
    .where('client.deletedAt IS NULL')
    .andWhere('LOWER(TRIM(client.email)) = :email', { email: emailLower })
    .getOne();
}

async function main() {
  const { filePath, updateExisting } = parseArgs();
  if (!filePath) {
    console.error('Usage: npm run import:leads -- <path-to.csv> [--update]');
    console.error('Example: npm run import:leads -- ./leads.csv');
    process.exit(1);
  }

  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    console.error('File not found:', abs);
    process.exit(1);
  }

  console.log('Connecting to database...');
  await AppDataSource.initialize();

  const repo = AppDataSource.getRepository(Client);
  const rows = await readCsvRows(abs);
  console.log(`Parsed ${rows.length} data row(s) from ${abs}`);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let skippedCsvDuplicate = 0;
  const errors = [];
  /** Emails already handled in this file (first row wins; later rows with same email are skipped). */
  const seenEmailInFile = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const lineNo = i + 2;

    try {
      const payload = rowToClientPayload(row);
      if (!payload) {
        errors.push({ line: lineNo, error: 'Missing email' });
        continue;
      }

      const emailKey = payload.email;
      if (seenEmailInFile.has(emailKey)) {
        skippedCsvDuplicate += 1;
        continue;
      }

      const existing = await findExistingByEmail(repo, emailKey);

      if (!existing) {
        const entity = repo.create(payload);
        await repo.save(entity);
        seenEmailInFile.add(emailKey);
        created += 1;
        continue;
      }

      seenEmailInFile.add(emailKey);

      if (!updateExisting) {
        skipped += 1;
        continue;
      }

      const merge = { ...payload };
      delete merge.email;
      const updates = {};
      for (const [k, v] of Object.entries(merge)) {
        if (v === undefined || v === null) continue;
        if (typeof v === 'string' && v === '') continue;
        if (Array.isArray(v) && v.length === 0) continue;
        updates[k] = v;
      }
      await repo.update({ id: existing.id }, updates);
      updated += 1;
    } catch (err) {
      errors.push({ line: lineNo, error: err.message || String(err) });
    }
  }

  await AppDataSource.destroy();

  console.log('Done.');
  console.log(`  Created: ${created}`);
  console.log(`  Updated: ${updated}${updateExisting ? '' : ' (use --update to merge into existing emails)'}`);
  console.log(`  Skipped (email already in database): ${skipped}`);
  if (skippedCsvDuplicate > 0) {
    console.log(`  Skipped (duplicate email within CSV): ${skippedCsvDuplicate}`);
  }
  if (errors.length) {
    console.log(`  Errors: ${errors.length}`);
    for (const e of errors.slice(0, 20)) {
      console.log(`    Line ${e.line}: ${e.error}`);
    }
    if (errors.length > 20) console.log(`    ... and ${errors.length - 20} more`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
