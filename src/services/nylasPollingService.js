import { AppDataSource } from '../config/database.js';
import { Email } from '../entities/Email.js';
import { NylasSlackNotification } from '../entities/NylasSlackNotification.js';
import { IncomingMessage } from '../entities/IncomingMessage.js';
import { In } from 'typeorm';
import {
  classifyIncomingMessage,
  ensureDefaultMessageTypeRules,
  loadMessageTypeRules,
} from './messageTypeService.js';
import {
  isIgnoredMarketingSender,
  isHiddenSender,
  MESSAGE_TYPE_IGNORED_SENDER,
  MESSAGE_TYPE_HIDE_SENDER,
} from './incomingSenderFilterService.js';
import { NYLAS_LIST_PAGE_LIMIT, parseNylas429RetryDelayMs, nylasFetchWithRetry, sleep } from '../utils/nylasRateLimit.js';
import { maybeCreateDomainBlockAlert } from './domainBlockAlertService.js';
import { markLeadsRepliedFromIncomingMessage } from './leadReplyStatusService.js';
import { getPollBackoffMsWhenHeavy, isHeavyWorkActive } from '../utils/backgroundWork.js';

const POLL_MS = Math.min(
  30 * 60 * 1000,
  Math.max(30_000, parseInt(process.env.NYLAS_POLL_MS || '', 10) || 60 * 1000)
);
/** Space out mailbox polls to reduce Gmail user quota bursts (ms). */
const POLL_STAGGER_MS = Math.min(
  10_000,
  Math.max(0, parseInt(process.env.NYLAS_POLL_STAGGER_MS || '400', 10) || 400)
);
/** After a 429, do not call Nylas for this grant again until this time (avoids long sleeps blocking other mailboxes). */
const grantPollBackoffUntil = new Map();
const seenMessageIds = new Set();
let timer = null;
let isRunning = false;
const configuredNylasRegion = (process.env.NYLAS_REGION || '').toLowerCase();
const SLACK_WEBHOOK_URL = process.env.SLACK_INCOMING_MESSAGES_WEBHOOK || '';

function getNylasBaseUrls() {
  if (configuredNylasRegion === 'us') return ['https://api.us.nylas.com'];
  if (configuredNylasRegion === 'eu') return ['https://api.eu.nylas.com'];
  // Auto mode: try EU first (legacy behavior), then US.
  return ['https://api.eu.nylas.com', 'https://api.us.nylas.com'];
}

function normalizeList(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    if (typeof item === 'string') return item;
    if (item?.email) return item.email;
    return '';
  }).filter(Boolean);
}

function getMessageBody(message) {
  return message?.body || message?.snippet || message?.text || '';
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlToReadableText(input) {
  if (!input) return '';
  const source = String(input);
  const hasHtml = /<\/?[a-z][\s\S]*>/i.test(source);
  if (!hasHtml) return source.trim();

  const withoutNoise = source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ');

  const withLineBreaks = withoutNoise
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<p[^>]*>/gi, '\n')
    .replace(/<div[^>]*>/gi, '\n');

  const noTags = withLineBreaks.replace(/<[^>]+>/g, ' ');
  const decoded = decodeHtmlEntities(noTags);

  return decoded
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
}

function limitTextLength(text, max = 3000) {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n...[truncated]`;
}

function normalizeSlackMessageText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Warm-up threads often append machine tokens to subject lines, e.g.
 * "Mattew - can I help? | DVRXVG6 B04JHEK". We don't want Slack noise for those.
 */
function isWarmupTokenSubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return false;
  return /\|\s*[A-Z0-9]{5,}\s+[A-Z0-9]{5,}\s*$/.test(s);
}

async function sendMessageToSlack({ emailAccount, subject, from, to, body }) {
  if (!SLACK_WEBHOOK_URL) return;
  const readableBody = normalizeSlackMessageText(limitTextLength(htmlToReadableText(body)));

  const text =
    `*New incoming email*\n` +
    `*Mailbox:* ${emailAccount}\n` +
    `*From:* ${from || '-'}\n` +
    `*To:* ${to || '-'}\n` +
    `*Subject:* ${subject || '(no subject)'}\n` +
    `*Message:*\n${readableBody || '-'}`;

  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: '#incoming-messages',
      text,
    }),
  });

  if (!response.ok) {
    const respText = await response.text().catch(() => '');
    throw new Error(`Slack webhook failed (${response.status}): ${respText || response.statusText}`);
  }
}

function formatFetchError(err) {
  if (!err) return 'Unknown error';
  const parts = [err.message || String(err)];
  if (err.cause) {
    parts.push(`cause: ${err.cause.message || err.cause}`);
  }
  return parts.join(' | ');
}

async function fetchUnreadMessagesForMailbox(emailRow) {
  const grantId = emailRow.grantId;
  const nylasKey = emailRow.nylasKey;
  const gid = String(grantId || '').trim();
  if (gid) {
    const until = grantPollBackoffUntil.get(gid);
    if (until && Date.now() < until) return;
  }

  let payload = null;
  let lastError = null;
  const baseUrls = getNylasBaseUrls();
  const listUrl = (baseUrl) =>
    `${baseUrl}/v3/grants/${grantId}/messages?limit=${NYLAS_LIST_PAGE_LIMIT}&unread=true`;

  for (const baseUrl of baseUrls) {
    const url = listUrl(baseUrl);
    try {
      const { response, text } = await nylasFetchWithRetry(
        url,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${nylasKey}`,
            Accept: 'application/json',
          },
        },
        { label: 'nylas-poll' }
      );

      if (response.ok) {
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          lastError = new Error(`Nylas invalid JSON on ${baseUrl}`);
          break;
        }
        if (gid) grantPollBackoffUntil.delete(gid);
        break;
      }

      if (response.status === 429) {
        const raw = parseNylas429RetryDelayMs(response, text);
        const backoffMs = Math.min(Math.max(raw, 15_000), 900_000);
        if (gid) grantPollBackoffUntil.set(gid, Date.now() + backoffMs);
        const resumeIso = new Date(Date.now() + backoffMs).toISOString();
        console.warn(
          `[NYLAS] 429 for ${emailRow.address} — backing off this grant until ~${resumeIso} (~${Math.round(backoffMs / 60_000)} min). Gmail/Nylas quota; other mailboxes still poll. Set NYLAS_POLL_MS (e.g. 120000) to poll less often.`
        );
        return;
      }

      const hint401 =
        response.status === 401
          ? ' (invalid or expired Nylas API key for this mailbox — check CRM email nylas_key matches your Nylas app)'
          : '';
      lastError = new Error(
        `Nylas request failed (${response.status}) on ${baseUrl}: ${text || response.statusText}${hint401}`
      );

      if (response.status === 401 && configuredNylasRegion) {
        throw lastError;
      }
    } catch (err) {
      if (lastError && err === lastError) throw err;
      const msg = formatFetchError(err);
      lastError = new Error(`Nylas fetch failed on ${baseUrl}: ${msg}`);
      if (configuredNylasRegion) {
        throw lastError;
      }
    }

    if (payload) break;
    if (configuredNylasRegion && lastError) throw lastError;
  }

  if (!payload) {
    throw lastError || new Error('Nylas request failed on all configured regions');
  }

  const messages = Array.isArray(payload?.data) ? payload.data : [];
  if (messages.length === 0) return;

  const notificationRepo = AppDataSource.getRepository(NylasSlackNotification);
  const incomingRepo = AppDataSource.getRepository(IncomingMessage);
  const messageTypeRules = await loadMessageTypeRules();
  const messageIds = messages.map((m) => m?.id).filter(Boolean);
  const alreadyNotifiedRows = messageIds.length
    ? await notificationRepo.find({
        where: {
          emailAddress: emailRow.address,
          messageId: In(messageIds),
        },
      })
    : [];
  const alreadyNotifiedIds = new Set(alreadyNotifiedRows.map((row) => row.messageId));
  // Includes soft-deleted rows so we do not insert again for the same Nylas message id.
  const existingIncomingRows = messageIds.length
    ? await incomingRepo.find({
        where: {
          emailAddress: emailRow.address,
          messageId: In(messageIds),
        },
      })
    : [];
  const existingIncomingIds = new Set(existingIncomingRows.map((row) => row.messageId));

  for (const message of messages) {
    const messageId = message?.id;
    if (!messageId || seenMessageIds.has(messageId) || existingIncomingIds.has(messageId)) continue;
    seenMessageIds.add(messageId);

    const fromAddresses = normalizeList(message?.from);
    const toAddresses = normalizeList(message?.to);
    const subject = message?.subject || '(no subject)';
    const body = getMessageBody(message);
    const receivedAt = message?.date ? new Date(message.date * 1000) : null;

    if (await isHiddenSender(fromAddresses)) {
      try {
        await incomingRepo.save(
          incomingRepo.create({
            emailAddress: emailRow.address,
            messageId,
            subject,
            fromEmail: fromAddresses[0] || null,
            messageType: MESSAGE_TYPE_HIDE_SENDER,
            receivedAt,
            isRead: true,
            source: 'nylas',
          })
        );
      } catch (error) {
        if (error?.code !== '23505') {
          console.error('[NYLAS] Failed storing hide-sender incoming message:', error.message || error);
        }
      }
      continue;
    }

    if (isIgnoredMarketingSender(fromAddresses)) {
      try {
        await incomingRepo.save(
          incomingRepo.create({
            emailAddress: emailRow.address,
            messageId,
            subject,
            fromEmail: fromAddresses[0] || null,
            messageType: MESSAGE_TYPE_IGNORED_SENDER,
            receivedAt,
            isRead: false,
            source: 'nylas',
          })
        );
      } catch (error) {
        if (error?.code !== '23505') {
          console.error('[NYLAS] Failed storing ignored-sender incoming message:', error.message || error);
        }
      }
      continue;
    }

    const classification = await classifyIncomingMessage({
      subject,
      body,
      fromEmail: fromAddresses.join(', '),
      toEmail: toAddresses.join(', '),
      rules: messageTypeRules,
    });
    const messageType = classification.messageType;
    const slackPayload = {
      emailAccount: emailRow.address,
      subject,
      from: fromAddresses.join(', '),
      to: toAddresses.join(', '),
      body,
    };

    const isWarmupSubject = isWarmupTokenSubject(subject);
    const shouldSendSlack =
      messageType === 'interest' &&
      !isWarmupSubject &&
      !alreadyNotifiedIds.has(messageId);
    if (shouldSendSlack) {
      try {
        await sendMessageToSlack(slackPayload);
      } catch (error) {
        console.error('[SLACK] Failed sending incoming message notification:', error.message || error);
      }

      try {
        await notificationRepo.save(
          notificationRepo.create({
            emailAddress: emailRow.address,
            messageId,
          })
        );
      } catch (error) {
        // Ignore duplicate key race; it's already marked as sent.
        if (error?.code !== '23505') {
          console.error('[NYLAS] Failed recording Slack notification state:', error.message || error);
        }
      }
    }

    try {
      await incomingRepo.save(
        incomingRepo.create({
          emailAddress: emailRow.address,
          messageId,
          subject,
            fromEmail: fromAddresses[0] || null,
          messageType,
          receivedAt,
            isRead: false,
          source: 'nylas',
          // Keep text for bounce/DSN matching (lead address is often only in the body).
          bodyText:
            messageType === 'blocked' ||
            messageType === 'delivery_failed' ||
            messageType === 'no_address' ||
            messageType === 'bad'
              ? String(body || '').slice(0, 8000) || null
              : null,
        })
      );
      try {
        await markLeadsRepliedFromIncomingMessage({
          mailboxAddress: emailRow.address,
          fromEmail: fromAddresses[0] || null,
          messageType,
          subject,
          body,
        });
      } catch (error) {
        console.error('[NYLAS] Failed marking lead replied:', error.message || error);
      }
    } catch (error) {
      if (error?.code !== '23505') {
        console.error('[NYLAS] Failed storing incoming message:', error.message || error);
      }
    }

    try {
      await maybeCreateDomainBlockAlert({
        mailboxAddress: emailRow.address,
        externalMessageId: messageId,
        subject,
        body,
        fromEmail: fromAddresses.join(', '),
      });
    } catch (error) {
      console.error('[NYLAS] Domain-block alert failed:', error.message || error);
    }
  }
}

async function pollUnreadEmails() {
  if (isRunning) {
    console.log('[NYLAS] Skipping tick — previous poll still running');
    return;
  }
  isRunning = true;

  try {
    await ensureDefaultMessageTypeRules();
    const emailRepository = AppDataSource.getRepository(Email);
    const emailAccounts = await emailRepository
      .createQueryBuilder('email')
      .where('email.deletedAt IS NULL')
      .andWhere('email.grant_id IS NOT NULL')
      .andWhere("TRIM(email.grant_id) <> ''")
      .andWhere('email.nylas_key IS NOT NULL')
      .andWhere("TRIM(email.nylas_key) <> ''")
      .getMany();

    const staggerMs = getPollBackoffMsWhenHeavy(POLL_STAGGER_MS);
    if (isHeavyWorkActive() && emailAccounts.length) {
      console.log(
        `[NYLAS] Heavy work active — using ${staggerMs}ms mailbox stagger (${emailAccounts.length} mailboxes)`
      );
    }

    for (let i = 0; i < emailAccounts.length; i += 1) {
      const emailRow = emailAccounts[i];
      try {
        await fetchUnreadMessagesForMailbox(emailRow);
      } catch (error) {
        console.error(`[NYLAS] Failed polling ${emailRow.address}:`, error.message || error, {
          grantId: emailRow.grantId,
        });
      }
      if (staggerMs > 0 && i < emailAccounts.length - 1) {
        await sleep(staggerMs);
      }
    }
  } catch (error) {
    console.error('[NYLAS] Polling job failed:', error.message || error);
  } finally {
    isRunning = false;
  }
}

export function startNylasUnreadPollingJob({ initialDelayMs = 0 } = {}) {
  if (timer) return;
  const kickoff = () => {
    pollUnreadEmails().catch(() => undefined);
    timer = setInterval(() => {
      pollUnreadEmails().catch(() => undefined);
    }, POLL_MS);
    console.log(`[NYLAS] Unread-email polling started (every ${Math.round(POLL_MS / 1000)}s)`);
  };
  if (initialDelayMs > 0) {
    console.log(`[NYLAS] First poll in ${Math.round(initialDelayMs / 1000)}s (staggered startup)`);
    setTimeout(kickoff, initialDelayMs);
  } else {
    kickoff();
  }
}

