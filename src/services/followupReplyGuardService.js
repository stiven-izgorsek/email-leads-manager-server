import { AppDataSource } from '../config/database.js';
import { getNylasBaseUrls } from './nylasCalendarService.js';
import { NYLAS_LIST_PAGE_LIMIT, sleep } from '../utils/nylasRateLimit.js';
import { normalizeTextForClassification } from './messageTypeService.js';

const configuredNylasRegion = (process.env.NYLAS_REGION || '').toLowerCase();

/** Classified inbound types that always mean "do not follow up" (includes bounces / blocks). */
const DEFINITE_REPLY_MESSAGE_TYPES = ['blocked', 'ooo', 'bad', 'interest', 'no_job'];

const BOUNCE_FROM_HINTS = [
  'mailer-daemon',
  'mail delivery',
  'postmaster',
  'noreply',
  'no-reply',
  'bounce',
  'daemon@',
  'microsoftexchange',
];

const BOUNCE_SUBJECT_HINTS = [
  'address not found',
  'message blocked',
  'undeliverable',
  'delivery failed',
  'delivery status notification',
  'returned mail',
  'mail delivery failed',
  'failure notice',
];

function normalizeEmail(addr) {
  const raw = String(addr || '').trim().toLowerCase();
  const angle = raw.match(/<([^>]+)>/);
  return (angle ? angle[1] : raw).trim();
}

function normalizeAddressList(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === 'string') return normalizeEmail(item);
      return normalizeEmail(item?.email);
    })
    .filter(Boolean);
}

function fromMatchesLead(fromRaw, leadEmail) {
  const lead = normalizeEmail(leadEmail);
  if (!lead) return false;
  const from = String(fromRaw || '').toLowerCase();
  return from.includes(lead);
}

function fromLooksLikeBounceOrSystem(fromRaw) {
  const from = String(fromRaw || '').toLowerCase();
  return BOUNCE_FROM_HINTS.some((hint) => from.includes(hint));
}

function textLooksLikeBounceOrBlock(subject, body) {
  const text = normalizeTextForClassification(`${subject || ''} ${body || ''}`);
  return BOUNCE_SUBJECT_HINTS.some((hint) => text.includes(hint));
}

/**
 * True if CRM has any stored inbound (polled) message after lastSent that counts as a reply.
 * Includes bounces/blocks (often from mailer-daemon, not the lead address).
 */
export async function hasStoredInboundReplySince({
  mailboxAddress,
  leadEmail,
  lastSent,
}) {
  const mailbox = String(mailboxAddress || '').trim();
  const lead = normalizeEmail(leadEmail);
  const since = lastSent instanceof Date ? lastSent : new Date(lastSent);
  if (!mailbox || !lead || Number.isNaN(since.getTime())) return false;

  const rows = await AppDataSource.manager.query(
    `SELECT 1 FROM incoming_message im
     WHERE im."emailAddress" = $1
       AND im."deletedAt" IS NULL
       AND im."messageType" <> 'ignored_sender'
       AND COALESCE(im."receivedAt", im."createdAt") > $2
       AND (
         LOWER(COALESCE(im."fromEmail", '')) LIKE $3
         OR im."messageType" = ANY($4::varchar[])
         OR (
           im."messageType" = 'other'
           AND (
             LOWER(COALESCE(im."fromEmail", '')) LIKE $3
             OR LOWER(COALESCE(im."fromEmail", '')) LIKE ANY($5::varchar[])
           )
         )
       )
     LIMIT 1`,
    [
      mailbox,
      since,
      `%${lead}%`,
      DEFINITE_REPLY_MESSAGE_TYPES,
      BOUNCE_FROM_HINTS.map((h) => `%${h}%`),
    ]
  );
  return rows.length > 0;
}

function isInboundReplyNylasMessage(message, mailboxAddress, leadEmail) {
  const mailbox = normalizeEmail(mailboxAddress);
  const lead = normalizeEmail(leadEmail);
  const fromList = normalizeAddressList(message?.from);
  const toList = normalizeAddressList(message?.to);

  const fromIsMailbox = fromList.includes(mailbox);
  const toIsMailbox = toList.includes(mailbox);
  const fromIsLead = fromList.some((f) => f === lead) || fromMatchesLead(fromList.join(' '), leadEmail);

  const subject = message?.subject || '';
  const body = message?.body || message?.snippet || message?.text || '';

  if (fromIsLead) return true;
  if (textLooksLikeBounceOrBlock(subject, body)) return true;

  if (toIsMailbox && !fromIsMailbox) {
    if (fromLooksLikeBounceOrSystem(fromList.join(' '))) return true;
    return true;
  }

  if (toIsMailbox && fromIsMailbox) return false;

  return false;
}

async function fetchNylasMessagesSince(grantId, nylasKey, { receivedAfter, anyEmail }) {
  const gid = String(grantId || '').trim();
  const key = String(nylasKey || '').trim();
  if (!gid || !key) return [];

  const params = new URLSearchParams({
    limit: String(NYLAS_LIST_PAGE_LIMIT),
    received_after: String(receivedAfter),
  });
  if (anyEmail) params.set('any_email', anyEmail);

  const all = [];
  let pageToken = null;

  for (const baseUrl of getNylasBaseUrls()) {
    try {
      for (let page = 0; page < 15; page += 1) {
        if (pageToken) params.set('page_token', pageToken);
        else params.delete('page_token');

        const url = `${baseUrl}/v3/grants/${encodeURIComponent(gid)}/messages?${params.toString()}`;
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
          },
        });
        if (!response.ok) {
          if (response.status === 401 && configuredNylasRegion) break;
          continue;
        }
        const payload = await response.json();
        const batch = Array.isArray(payload?.data) ? payload.data : [];
        all.push(...batch);
        pageToken =
          payload?.next_cursor || payload?.nextCursor || payload?.next_page_token || null;
        if (!pageToken || batch.length === 0) break;
        await sleep(100);
      }
      if (all.length) return all;
    } catch {
      if (configuredNylasRegion) break;
    }
  }
  return all;
}

/**
 * Live Nylas check for any inbound after lastSent (lead reply, bounce, block, OOO, etc.).
 */
export async function hasNylasInboundReplySince({
  grantId,
  nylasKey,
  mailboxAddress,
  leadEmail,
  lastSent,
}) {
  const since = lastSent instanceof Date ? lastSent : new Date(lastSent);
  if (!grantId || !nylasKey || Number.isNaN(since.getTime())) return false;

  const receivedAfter = Math.floor(since.getTime() / 1000) - 60;
  const lead = normalizeEmail(leadEmail);

  const messages = await fetchNylasMessagesSince(grantId, nylasKey, {
    receivedAfter,
    anyEmail: lead || undefined,
  });

  for (const message of messages) {
    const msgDate = typeof message?.date === 'number' ? message.date * 1000 : null;
    if (msgDate != null && msgDate <= since.getTime()) continue;
    if (isInboundReplyNylasMessage(message, mailboxAddress, leadEmail)) return true;
  }

  return false;
}

/**
 * Combined guard for assign + send — never follow up when any reply exists.
 */
export async function leadHasInboundReplySinceSend({
  mailboxAddress,
  leadEmail,
  lastSent,
  grantId,
  nylasKey,
  checkNylas = true,
}) {
  if (!lastSent) return false;

  const stored = await hasStoredInboundReplySince({ mailboxAddress, leadEmail, lastSent });
  if (stored) return { hasReply: true, source: 'incoming_message' };

  if (checkNylas && grantId && nylasKey) {
    const live = await hasNylasInboundReplySince({
      grantId,
      nylasKey,
      mailboxAddress,
      leadEmail,
      lastSent,
    });
    if (live) return { hasReply: true, source: 'nylas' };
  }

  return { hasReply: false, source: null };
}
