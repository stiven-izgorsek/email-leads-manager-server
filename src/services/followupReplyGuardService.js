import { AppDataSource } from '../config/database.js';
import { getNylasBaseUrls } from './nylasCalendarService.js';
import { fetchNylasMessageById } from './nylasOriginalMessageService.js';
import { NYLAS_LIST_PAGE_LIMIT, sleep } from '../utils/nylasRateLimit.js';
import { normalizeTextForClassification } from './messageTypeService.js';

const configuredNylasRegion = (process.env.NYLAS_REGION || '').toLowerCase();

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
 * True if CRM has any stored inbound (polled) message after lastSent that counts as a reply
 * for this specific lead. Logic matches fetchFollowupCandidateClients NOT EXISTS filter.
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
       AND im."messageType" <> 'hide_sender'
       AND COALESCE(im."receivedAt", im."createdAt") > $2
       AND (
         LOWER(COALESCE(im."fromEmail", '')) LIKE $3
         OR (
           im."messageType" IN ('blocked', 'delivery_failed', 'no_address', 'ooo', 'bad', 'interest', 'no_job', 'other')
           AND (
             LOWER(COALESCE(im."fromEmail", '')) LIKE $3
             OR LOWER(COALESCE(im."subject", '')) LIKE $3
           )
         )
         OR (
           (
             LOWER(COALESCE(im."fromEmail", '')) LIKE '%mailer-daemon%'
             OR LOWER(COALESCE(im."fromEmail", '')) LIKE '%postmaster%'
             OR LOWER(COALESCE(im."fromEmail", '')) LIKE '%mail delivery%'
             OR im."messageType" IN ('blocked', 'delivery_failed', 'no_address')
           )
           AND LOWER(COALESCE(im."subject", '')) LIKE $3
         )
       )
     LIMIT 1`,
    [mailbox, since, `%${lead}%`]
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
  const subjectLower = String(subject).toLowerCase();
  const leadInSubject = !!(lead && subjectLower.includes(lead));
  const fromStr = fromList.join(' ').toLowerCase();

  if (fromIsLead) return true;

  if (textLooksLikeBounceOrBlock(subject, body) && leadInSubject) {
    return true;
  }

  if (
    (fromStr.includes('mailer-daemon') || fromStr.includes('postmaster') || fromLooksLikeBounceOrSystem(fromStr)) &&
    leadInSubject
  ) {
    return true;
  }

  // Do not treat unrelated mailbox bounces as a reply for this lead.
  if (toIsMailbox && fromIsMailbox) return false;

  return false;
}

function isThreadDisqualifyingMessage(message, _mailboxAddress, _leadEmail, originalMessageId, originalTs) {
  const mid = String(message?.id || '').trim();
  if (!mid || mid === String(originalMessageId || '').trim()) return false;

  const msgTs = typeof message?.date === 'number' ? message.date : null;
  if (originalTs != null && msgTs != null && msgTs < originalTs - 120) return false;

  // Any other message in the thread after our outbound (reply, bounce, OOO, etc.)
  return true;
}

async function fetchNylasThread(grantId, nylasKey, threadId) {
  const gid = String(grantId || '').trim();
  const key = String(nylasKey || '').trim();
  const tid = String(threadId || '').trim();
  if (!gid || !key || !tid) return null;

  for (const baseUrl of getNylasBaseUrls()) {
    try {
      const response = await fetch(
        `${baseUrl}/v3/grants/${encodeURIComponent(gid)}/threads/${encodeURIComponent(tid)}`,
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

async function fetchNylasMessagesForThread(grantId, nylasKey, threadId, { receivedAfter } = {}) {
  const gid = String(grantId || '').trim();
  const key = String(nylasKey || '').trim();
  const tid = String(threadId || '').trim();
  if (!gid || !key || !tid) return [];

  const params = new URLSearchParams({
    limit: String(NYLAS_LIST_PAGE_LIMIT),
    thread_id: tid,
  });
  if (receivedAfter != null) params.set('received_after', String(receivedAfter));

  const all = [];
  let pageToken = null;

  for (const baseUrl of getNylasBaseUrls()) {
    try {
      for (let page = 0; page < 10; page += 1) {
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
        await sleep(80);
      }
      if (all.length) return all;
    } catch {
      if (configuredNylasRegion) break;
    }
  }
  return all;
}

/**
 * True when the Nylas thread for the original outbound has any reply or delivery failure
 * after that send (single-message threads with only the outreach are eligible).
 */
export async function threadHasReplyOrDeliveryIssueAfterOutbound({
  grantId,
  nylasKey,
  mailboxAddress,
  leadEmail,
  originalMessageId,
}) {
  const originalId = String(originalMessageId || '').trim();
  if (!grantId || !nylasKey || !originalId) {
    return { hasIssue: false, source: null };
  }

  const original = await fetchNylasMessageById(grantId, nylasKey, originalId);
  if (!original) return { hasIssue: false, source: null };

  const originalTs = typeof original?.date === 'number' ? original.date : null;
  const threadId = String(original?.thread_id || original?.threadId || '').trim();

  let threadMessages = [];
  if (threadId) {
    threadMessages = await fetchNylasMessagesForThread(grantId, nylasKey, threadId, {
      receivedAfter: originalTs != null ? originalTs - 120 : undefined,
    });
  }

  if (!threadMessages.length) {
    const thread = threadId ? await fetchNylasThread(grantId, nylasKey, threadId) : null;
    const ids = Array.isArray(thread?.message_ids)
      ? thread.message_ids
      : Array.isArray(thread?.messageIds)
        ? thread.messageIds
        : [];
    const otherIds = ids.filter((id) => String(id).trim() !== originalId);
    if (!otherIds.length) return { hasIssue: false, source: null };

    for (const id of otherIds) {
      const msg = await fetchNylasMessageById(grantId, nylasKey, id);
      if (msg && isThreadDisqualifyingMessage(msg, mailboxAddress, leadEmail, originalId, originalTs)) {
        return { hasIssue: true, source: 'thread' };
      }
    }
    return { hasIssue: false, source: null };
  }

  for (const message of threadMessages) {
    if (isThreadDisqualifyingMessage(message, mailboxAddress, leadEmail, originalId, originalTs)) {
      return { hasIssue: true, source: 'thread' };
    }
  }

  return { hasIssue: false, source: null };
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
  if (!lastSent) return { hasReply: false, source: null };

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

/**
 * Assign + send guard: only threads with no lead reply and no delivery failure after outbound.
 */
export async function leadIsEligibleForFollowup({
  mailboxAddress,
  leadEmail,
  lastSent,
  grantId,
  nylasKey,
  originalMessageId,
  checkNylas = true,
}) {
  const replyCheck = await leadHasInboundReplySinceSend({
    mailboxAddress,
    leadEmail,
    lastSent,
    grantId,
    nylasKey,
    checkNylas,
  });
  if (replyCheck.hasReply) {
    return { eligible: false, reason: replyCheck.source || 'reply' };
  }

  if (checkNylas && grantId && nylasKey && originalMessageId) {
    const threadCheck = await threadHasReplyOrDeliveryIssueAfterOutbound({
      grantId,
      nylasKey,
      mailboxAddress,
      leadEmail,
      originalMessageId,
    });
    if (threadCheck.hasIssue) {
      return { eligible: false, reason: threadCheck.source || 'thread' };
    }
  }

  return { eligible: true, reason: null };
}
