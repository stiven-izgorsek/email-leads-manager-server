import { AppDataSource } from '../config/database.js';
import { Client } from '../entities/Client.js';

const SKIP_MESSAGE_TYPES = new Set(['ignored_sender', 'hide_sender']);

/** Do not overwrite these CRM pipeline statuses when marking a reply/bounce. */
const PROTECTED_STATUSES = new Set(['demoed', 'onboarding', 'hired']);

const SYSTEM_FROM_HINTS = [
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
  'message not delivered',
  'delivery has failed',
];

const EMAIL_IN_TEXT_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export function normalizeReplyEmail(addr) {
  const raw = String(addr || '').trim().toLowerCase();
  if (!raw) return '';
  const angle = raw.match(/<([^>]+)>/);
  return (angle ? angle[1] : raw).trim();
}

function isSystemSender(fromEmail) {
  const from = String(fromEmail || '').toLowerCase();
  if (!from) return false;
  return SYSTEM_FROM_HINTS.some((hint) => from.includes(hint));
}

function looksLikeBounceText(subject, body) {
  const text = `${subject || ''} ${body || ''}`.toLowerCase();
  return BOUNCE_SUBJECT_HINTS.some((hint) => text.includes(hint));
}

function extractEmailsFromText(...parts) {
  const found = new Set();
  for (const part of parts) {
    const matches = String(part || '').match(EMAIL_IN_TEXT_RE) || [];
    for (const m of matches) {
      const email = normalizeReplyEmail(m);
      if (email) found.add(email);
    }
  }
  return [...found];
}

/**
 * Map inbound classification → CRM status for do-not-follow-up.
 * Always sets isReplied=true so follow-up assign skips the lead.
 */
function resolveDoNotFollowupStatus(messageType, { isBounce }) {
  const type = String(messageType || '').trim().toLowerCase();
  if (isBounce || type === 'blocked' || type === 'delivery_failed' || type === 'no_address') return 'bounced';
  if (type === 'bad') return 'bad';
  return 'replied';
}

async function markClientsDoNotFollowup(clients, { messageType, isBounce, reason }) {
  if (!clients.length) return [];
  const clientRepo = AppDataSource.getRepository(Client);
  const ids = [];

  for (const client of clients) {
    const status = String(client.status || '').trim().toLowerCase();
    const alreadyReplied = client.isReplied === true;
    const statusProtected = PROTECTED_STATUSES.has(status);
    const terminal = ['replied', 'bounced', 'bad'].includes(status);

    if (alreadyReplied && (statusProtected || terminal)) {
      continue;
    }

    const patch = {
      isReplied: true,
      updatedAt: new Date(),
    };
    if (!statusProtected) {
      patch.status = resolveDoNotFollowupStatus(messageType, { isBounce });
    }

    await clientRepo.update({ id: client.id }, patch);
    ids.push(client.id);
  }

  if (ids.length) {
    console.log(`[lead-reply] marked ${ids.length} lead(s) do-not-follow-up (${reason})`);
  }
  return ids;
}

async function findMailboxLeadsByEmails(mailboxAddress, emails) {
  const mailbox = String(mailboxAddress || '').trim().toLowerCase();
  const list = [...new Set((emails || []).map(normalizeReplyEmail).filter(Boolean))];
  if (!mailbox || !list.length) return [];

  const clientRepo = AppDataSource.getRepository(Client);
  return clientRepo
    .createQueryBuilder('client')
    .where('client.deletedAt IS NULL')
    .andWhere('LOWER(TRIM(client.email)) IN (:...emails)', { emails: list })
    .andWhere("LOWER(COALESCE(client.sentBy, '')) LIKE :mailbox", {
      mailbox: `%${mailbox}%`,
    })
    .getMany();
}

/**
 * Mark CRM leads as do-not-follow-up when inbound mail indicates a reply,
 * bounce, block, or unsubscribe for leads sent from this mailbox.
 *
 * @returns {{ updated: number, ids: string[] }}
 */
export async function markLeadsRepliedFromIncomingMessage({
  mailboxAddress,
  fromEmail,
  messageType,
  subject = null,
  body = null,
}) {
  const type = String(messageType || '').trim().toLowerCase();
  if (SKIP_MESSAGE_TYPES.has(type)) {
    return { updated: 0, ids: [] };
  }

  const mailbox = String(mailboxAddress || '').trim();
  if (!mailbox) return { updated: 0, ids: [] };

  const from = normalizeReplyEmail(fromEmail);
  const system = isSystemSender(fromEmail);
  const bounceText = looksLikeBounceText(subject, body);
  const isBounce =
    system ||
    type === 'blocked' ||
    type === 'delivery_failed' ||
    type === 'no_address' ||
    bounceText;

  /** @type {string[]} */
  let targetEmails = [];

  if (from && !system) {
    // Human (or lead-looking) sender: match by from address.
    targetEmails = [from];
  } else if (isBounce) {
    // Bounce/DSN: lead address is usually in subject/body, not From.
    targetEmails = extractEmailsFromText(subject, body).filter((e) => e !== from);
  }

  if (!targetEmails.length) {
    return { updated: 0, ids: [] };
  }

  const clients = await findMailboxLeadsByEmails(mailbox, targetEmails);
  if (!clients.length) {
    return { updated: 0, ids: [] };
  }

  const reason = isBounce
    ? `bounce/block ${from || 'system'} → ${mailbox}`
    : `${from} (${type || 'other'}) → ${mailbox}`;

  const ids = await markClientsDoNotFollowup(clients, {
    messageType: type,
    isBounce: Boolean(
      isBounce &&
        (system ||
          type === 'blocked' ||
          type === 'delivery_failed' ||
          type === 'no_address' ||
          bounceText)
    ),
    reason,
  });

  return { updated: ids.length, ids };
}

/**
 * Backfill do-not-follow-up from stored incoming_message rows:
 * - human fromEmail matches lead email
 * - bounce/blocked where subject/body contains lead email
 *
 * @returns {Promise<{ humanUpdated: number, bounceUpdated: number }>}
 */
export async function backfillLeadRepliedFromIncomingMessages() {
  const human = await AppDataSource.manager.query(
    `
    WITH matched AS (
      SELECT DISTINCT c.id AS client_id,
             LOWER(TRIM(COALESCE(c.status, ''))) AS status_norm,
             LOWER(TRIM(COALESCE(im."messageType", ''))) AS msg_type
      FROM client c
      INNER JOIN incoming_message im
        ON im."deletedAt" IS NULL
       AND im."fromEmail" IS NOT NULL
       AND TRIM(im."fromEmail") <> ''
       AND im."messageType" IS DISTINCT FROM 'ignored_sender'
       AND im."messageType" IS DISTINCT FROM 'hide_sender'
       AND LOWER(TRIM(BOTH FROM regexp_replace(LOWER(TRIM(im."fromEmail")), '^.*<([^>]+)>.*$', '\\1')))
           = LOWER(TRIM(c.email))
       AND LOWER(COALESCE(c."sentBy", '')) LIKE ('%' || LOWER(im."emailAddress") || '%')
      WHERE c."deletedAt" IS NULL
        AND c.email IS NOT NULL
        AND TRIM(c.email) <> ''
        AND LOWER(TRIM(im."fromEmail")) NOT LIKE '%mailer-daemon%'
        AND LOWER(TRIM(im."fromEmail")) NOT LIKE '%postmaster%'
        AND LOWER(TRIM(im."fromEmail")) NOT LIKE '%mail delivery%'
        AND (
          c."isReplied" IS NOT TRUE
          OR LOWER(TRIM(COALESCE(c.status, ''))) NOT IN ('replied', 'bounced', 'bad', 'demoed', 'onboarding', 'hired')
        )
    )
    UPDATE client c
    SET
      "isReplied" = true,
      status = CASE
        WHEN m.status_norm IN ('demoed', 'onboarding', 'hired') THEN c.status
        WHEN m.msg_type IN ('blocked', 'delivery_failed', 'no_address') THEN 'bounced'
        WHEN m.msg_type = 'bad' THEN 'bad'
        ELSE 'replied'
      END,
      "updatedAt" = NOW()
    FROM matched m
    WHERE c.id = m.client_id
    RETURNING c.id
    `
  );

  const bounce = await AppDataSource.manager.query(
    `
    WITH matched AS (
      SELECT DISTINCT c.id AS client_id,
             LOWER(TRIM(COALESCE(c.status, ''))) AS status_norm
      FROM client c
      INNER JOIN incoming_message im
        ON im."deletedAt" IS NULL
       AND im."messageType" IS DISTINCT FROM 'ignored_sender'
       AND im."messageType" IS DISTINCT FROM 'hide_sender'
       AND (
         im."messageType" IN ('blocked', 'delivery_failed', 'no_address')
         OR LOWER(COALESCE(im."fromEmail", '')) LIKE '%mailer-daemon%'
         OR LOWER(COALESCE(im."fromEmail", '')) LIKE '%postmaster%'
         OR LOWER(COALESCE(im."fromEmail", '')) LIKE '%mail delivery%'
         OR LOWER(COALESCE(im.subject, '')) LIKE '%address not found%'
         OR LOWER(COALESCE(im.subject, '')) LIKE '%undeliverable%'
         OR LOWER(COALESCE(im.subject, '')) LIKE '%delivery status notification%'
         OR LOWER(COALESCE(im.subject, '')) LIKE '%delivery failed%'
       )
       AND (
         LOWER(COALESCE(im.subject, '')) LIKE ('%' || LOWER(TRIM(c.email)) || '%')
         OR LOWER(COALESCE(im.body_text, '')) LIKE ('%' || LOWER(TRIM(c.email)) || '%')
       )
       AND LOWER(COALESCE(c."sentBy", '')) LIKE ('%' || LOWER(im."emailAddress") || '%')
      WHERE c."deletedAt" IS NULL
        AND c.email IS NOT NULL
        AND TRIM(c.email) <> ''
        AND (
          c."isReplied" IS NOT TRUE
          OR LOWER(TRIM(COALESCE(c.status, ''))) NOT IN ('replied', 'bounced', 'bad', 'demoed', 'onboarding', 'hired')
        )
    )
    UPDATE client c
    SET
      "isReplied" = true,
      status = CASE
        WHEN m.status_norm IN ('demoed', 'onboarding', 'hired') THEN c.status
        ELSE 'bounced'
      END,
      "updatedAt" = NOW()
    FROM matched m
    WHERE c.id = m.client_id
    RETURNING c.id
    `
  );

  return {
    humanUpdated: Array.isArray(human) ? human.length : 0,
    bounceUpdated: Array.isArray(bounce) ? bounce.length : 0,
  };
}
