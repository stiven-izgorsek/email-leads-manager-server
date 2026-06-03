import { AppDataSource } from '../config/database.js';
import { MarketingAssignmentLead } from '../entities/MarketingAssignmentLead.js';
import { getNylasBaseUrls } from './nylasCalendarService.js';
import { NYLAS_LIST_PAGE_LIMIT, sleep } from '../utils/nylasRateLimit.js';

const configuredNylasRegion = (process.env.NYLAS_REGION || '').toLowerCase();

function normalizeEmail(addr) {
  const raw = String(addr || '').trim().toLowerCase();
  const angle = raw.match(/<([^>]+)>/);
  return (angle ? angle[1] : raw).trim();
}

function messageFromMatches(message, mailboxEmail) {
  const mailbox = normalizeEmail(mailboxEmail);
  const fromList = Array.isArray(message?.from) ? message.from : [];
  for (const item of fromList) {
    const email = typeof item === 'string' ? item : item?.email;
    if (normalizeEmail(email) === mailbox) return true;
  }
  return false;
}

function messageToMatches(message, leadEmail) {
  const lead = normalizeEmail(leadEmail);
  const toList = Array.isArray(message?.to) ? message.to : [];
  for (const item of toList) {
    const email = typeof item === 'string' ? item : item?.email;
    if (normalizeEmail(email) === lead) return true;
  }
  return false;
}

/**
 * Prefer Nylas marketing send record, then search Nylas for the outbound message to this lead.
 * @returns {Promise<{ messageId: string, subject: string } | null>}
 */
export async function resolveOriginalOutboundForFollowup({
  emailId,
  grantId,
  nylasKey,
  mailboxAddress,
  clientId,
  leadEmail,
  lastSent,
}) {
  const stored = await findStoredMarketingNylasMessage(emailId, clientId);
  if (stored?.messageId) return stored;

  if (!grantId || !nylasKey || !leadEmail || !lastSent) return null;

  return findNylasOutboundToLead({
    grantId,
    nylasKey,
    mailboxAddress,
    leadEmail,
    lastSent,
  });
}

async function findStoredMarketingNylasMessage(emailId, clientId) {
  const malRepo = AppDataSource.getRepository(MarketingAssignmentLead);
  const row = await malRepo
    .createQueryBuilder('mal')
    .innerJoin('mal.assignment', 'ma')
    .where('ma.emailId = :emailId', { emailId })
    .andWhere('mal.clientId = :clientId', { clientId })
    .andWhere('mal.sendStatus = :sent', { sent: 'sent' })
    .andWhere('mal.nylasMessageId IS NOT NULL')
    .andWhere("TRIM(mal.nylasMessageId) <> ''")
    .orderBy('mal.sentAt', 'DESC')
    .addOrderBy('mal.createdAt', 'DESC')
    .getOne();

  if (!row?.nylasMessageId) return null;
  return {
    messageId: String(row.nylasMessageId).trim(),
    subject: String(row.subject || '').trim() || '(no subject)',
  };
}

async function fetchNylasMessageById(grantId, nylasKey, messageId) {
  const gid = String(grantId || '').trim();
  const key = String(nylasKey || '').trim();
  const mid = String(messageId || '').trim();
  if (!gid || !key || !mid) return null;

  for (const baseUrl of getNylasBaseUrls()) {
    try {
      const response = await fetch(
        `${baseUrl}/v3/grants/${encodeURIComponent(gid)}/messages/${encodeURIComponent(mid)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
          },
        }
      );
      if (response.ok) {
        const payload = await response.json();
        return payload?.data || payload;
      }
      if (response.status === 401 && configuredNylasRegion) break;
    } catch {
      if (configuredNylasRegion) break;
    }
  }
  return null;
}

/**
 * Search Nylas messages to the lead around lastSent and pick the outbound from this mailbox.
 */
async function findNylasOutboundToLead({ grantId, nylasKey, mailboxAddress, leadEmail, lastSent }) {
  const sentMs = lastSent instanceof Date ? lastSent.getTime() : new Date(lastSent).getTime();
  if (!Number.isFinite(sentMs)) return null;

  const receivedAfter = Math.floor((sentMs - 3 * 86400000) / 1000);
  const receivedBefore = Math.floor((sentMs + 2 * 86400000) / 1000);
  const lead = normalizeEmail(leadEmail);

  const baseUrls = getNylasBaseUrls();
  let best = null;
  let bestDelta = Infinity;

  for (const baseUrl of baseUrls) {
    let pageToken = null;
    for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({
        limit: String(NYLAS_LIST_PAGE_LIMIT),
        received_after: String(receivedAfter),
        received_before: String(receivedBefore),
      });
      params.set('any_email', lead);
      if (pageToken) params.set('page_token', pageToken);

      const url = `${baseUrl}/v3/grants/${encodeURIComponent(grantId)}/messages?${params.toString()}`;
      let payload = null;
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${nylasKey}`,
            Accept: 'application/json',
          },
        });
        if (!response.ok) {
          if (response.status === 401 && configuredNylasRegion) break;
          continue;
        }
        payload = await response.json();
      } catch {
        continue;
      }

      const batch = Array.isArray(payload?.data) ? payload.data : [];
      for (const message of batch) {
        if (!messageFromMatches(message, mailboxAddress)) continue;
        if (!messageToMatches(message, leadEmail)) continue;
        const msgDate = typeof message.date === 'number' ? message.date * 1000 : sentMs;
        const delta = Math.abs(msgDate - sentMs);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = message;
        }
      }

      pageToken =
        payload?.next_cursor || payload?.nextCursor || payload?.next_page_token || null;
      if (!pageToken || batch.length === 0) break;
      await sleep(120);
    }
    if (best) break;
  }

  if (!best?.id) return null;

  let subject = String(best.subject || '').trim();
  if (!subject) {
    const full = await fetchNylasMessageById(grantId, nylasKey, best.id);
    subject = String(full?.subject || '').trim();
  }

  return {
    messageId: String(best.id).trim(),
    subject: subject || '(no subject)',
  };
}
