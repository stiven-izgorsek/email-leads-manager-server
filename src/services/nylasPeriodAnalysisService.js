import { AppDataSource } from '../config/database.js';
import { Email } from '../entities/Email.js';
import {
  classifyIncomingMessage,
  ensureDefaultMessageTypeRules,
  loadMessageTypeRules,
} from './messageTypeService.js';
import { NYLAS_LIST_PAGE_LIMIT, parseNylas429RetryDelayMs, sleep } from '../utils/nylasRateLimit.js';

const configuredNylasRegion = (process.env.NYLAS_REGION || '').toLowerCase();
const NYLAS_PAGE_GAP_MS = Math.min(5000, Math.max(50, parseInt(process.env.NYLAS_PAGE_GAP_MS || '150', 10) || 150));
const NYLAS_429_MAX_RETRIES = Math.min(5, Math.max(0, parseInt(process.env.NYLAS_429_MAX_RETRIES || '2', 10) || 2));

function getNylasBaseUrls() {
  if (configuredNylasRegion === 'us') return ['https://api.us.nylas.com'];
  if (configuredNylasRegion === 'eu') return ['https://api.eu.nylas.com'];
  return ['https://api.eu.nylas.com', 'https://api.us.nylas.com'];
}

function normalizeList(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item?.email) return item.email;
      return '';
    })
    .filter(Boolean);
}

function getMessageBody(message) {
  return message?.body || message?.snippet || message?.text || '';
}

/**
 * Compute Nylas `received_after` / `received_before` (Unix seconds).
 */
export function computeReceivedRange(preset, n) {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  let fromSec;
  let label;

  switch (preset) {
    case 'today': {
      const d = new Date();
      const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
      fromSec = Math.floor(start / 1000);
      label = 'Today (UTC)';
      break;
    }
    case 'this_week': {
      const d = new Date();
      const day = d.getUTCDay();
      const diff = (day + 6) % 7;
      d.setUTCDate(d.getUTCDate() - diff);
      d.setUTCHours(0, 0, 0, 0);
      fromSec = Math.floor(d.getTime() / 1000);
      label = 'This week (UTC, from Monday)';
      break;
    }
    case 'this_month': {
      const d = new Date();
      const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
      fromSec = Math.floor(start / 1000);
      label = 'This month (UTC)';
      break;
    }
    case 'last_n_days': {
      const num = Math.min(365, Math.max(1, parseInt(n, 10) || 1));
      fromSec = Math.floor((nowMs - num * 86400000) / 1000);
      label = `Last ${num} day(s)`;
      break;
    }
    case 'last_n_weeks': {
      const num = Math.min(52, Math.max(1, parseInt(n, 10) || 1));
      fromSec = Math.floor((nowMs - num * 7 * 86400000) / 1000);
      label = `Last ${num} week(s)`;
      break;
    }
    case 'last_n_months': {
      const num = Math.min(36, Math.max(1, parseInt(n, 10) || 1));
      const d = new Date();
      d.setUTCMonth(d.getUTCMonth() - num);
      fromSec = Math.floor(d.getTime() / 1000);
      label = `Last ${num} month(s)`;
      break;
    }
    default:
      throw new Error(`Unknown period preset: ${preset}`);
  }

  return {
    receivedAfter: fromSec,
    receivedBefore: nowSec,
    label,
    fromIso: new Date(fromSec * 1000).toISOString(),
    toIso: new Date(nowSec * 1000).toISOString(),
  };
}

async function fetchMessagesPage(baseUrl, grantId, nylasKey, { receivedAfter, receivedBefore, limit, pageToken }) {
  const pageLimit = Math.min(NYLAS_LIST_PAGE_LIMIT, Math.max(1, limit || NYLAS_LIST_PAGE_LIMIT));
  const params = new URLSearchParams({ limit: String(pageLimit) });
  if (receivedAfter != null) params.set('received_after', String(receivedAfter));
  if (receivedBefore != null) params.set('received_before', String(receivedBefore));
  if (pageToken) params.set('page_token', pageToken);

  const url = `${baseUrl}/v3/grants/${grantId}/messages?${params.toString()}`;

  for (let attempt = 0; attempt <= NYLAS_429_MAX_RETRIES; attempt += 1) {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${nylasKey}`,
        Accept: 'application/json',
      },
    });

    const text = await response.text().catch(() => '');

    if (response.ok) {
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        throw new Error('Nylas returned invalid JSON for messages page');
      }
    }

    if (response.status === 429 && attempt < NYLAS_429_MAX_RETRIES) {
      const waitMs = parseNylas429RetryDelayMs(response, text);
      await sleep(waitMs);
      continue;
    }

    throw new Error(`Nylas request failed (${response.status}): ${text || response.statusText}`);
  }

  throw new Error('Nylas messages page: exceeded 429 retries');
}

async function fetchAllMessagesInRange(grantId, nylasKey, receivedAfter, receivedBefore) {
  const baseUrls = getNylasBaseUrls();
  let lastError = null;

  for (const baseUrl of baseUrls) {
    try {
      const all = [];
      let pageToken = undefined;
      for (let page = 0; page < 500; page += 1) {
        const payload = await fetchMessagesPage(baseUrl, grantId, nylasKey, {
          receivedAfter,
          receivedBefore,
          limit: NYLAS_LIST_PAGE_LIMIT,
          pageToken,
        });
        const batch = Array.isArray(payload?.data) ? payload.data : [];
        all.push(...batch);
        pageToken =
          payload?.next_cursor || payload?.nextCursor || payload?.next_page_token || payload?.nextPageToken || null;
        if (!pageToken || batch.length === 0) break;
        await sleep(NYLAS_PAGE_GAP_MS);
      }
      return all;
    } catch (err) {
      lastError = err;
      if (configuredNylasRegion) throw err;
      continue;
    }
  }

  throw lastError || new Error('Nylas request failed on all configured regions');
}

/**
 * Fetches messages from Nylas for each integrated mailbox, classifies in memory (no DB writes).
 */
export async function analyzeNylasMessagesForPeriod({ preset, n }) {
  await ensureDefaultMessageTypeRules();
  const rules = await loadMessageTypeRules();
  const range = computeReceivedRange(preset, n);

  const emailRepo = AppDataSource.getRepository(Email);
  const accounts = await emailRepo
    .createQueryBuilder('email')
    .where('email.deletedAt IS NULL')
    .andWhere('email.grant_id IS NOT NULL')
    .andWhere("TRIM(email.grant_id) <> ''")
    .andWhere('email.nylas_key IS NOT NULL')
    .andWhere("TRIM(email.nylas_key) <> ''")
    .getMany();

  const data = [];

  for (const emailRow of accounts) {
    try {
      const messages = await fetchAllMessagesInRange(
        emailRow.grantId,
        emailRow.nylasKey,
        range.receivedAfter,
        range.receivedBefore
      );

      const counts = {};
      let total = 0;

      for (const message of messages) {
        const msgDate = message?.date;
        if (typeof msgDate === 'number') {
          if (msgDate < range.receivedAfter || msgDate > range.receivedBefore) continue;
        }

        const fromAddresses = normalizeList(message?.from);
        const toAddresses = normalizeList(message?.to);
        const subject = message?.subject || '';
        const body = getMessageBody(message);

        const classification = await classifyIncomingMessage({
          subject,
          body,
          fromEmail: fromAddresses.join(', '),
          toEmail: toAddresses.join(', '),
          rules,
        });

        const t = classification.messageType || 'other';
        counts[t] = (counts[t] || 0) + 1;
        total += 1;
      }

      data.push({
        emailAddress: emailRow.address,
        total,
        counts,
        error: null,
      });
    } catch (err) {
      data.push({
        emailAddress: emailRow.address,
        total: 0,
        counts: {},
        error: err?.message || String(err),
      });
    }

    await sleep(Math.min(2000, Math.max(80, NYLAS_PAGE_GAP_MS)));
  }

  return {
    period: {
      preset,
      n: n ?? null,
      label: range.label,
      from: range.fromIso,
      to: range.toIso,
      receivedAfter: range.receivedAfter,
      receivedBefore: range.receivedBefore,
    },
    mailboxCount: accounts.length,
    data,
  };
}
