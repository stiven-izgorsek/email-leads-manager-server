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

const POLL_MS = 60 * 1000;
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

  let payload = null;
  let lastError = null;
  const baseUrls = getNylasBaseUrls();

  for (const baseUrl of baseUrls) {
    const url = `${baseUrl}/v3/grants/${grantId}/messages?limit=25&unread=true`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${nylasKey}`,
          Accept: 'application/json',
        },
      });

      if (response.ok) {
        payload = await response.json();
        break;
      }

      const text = await response.text().catch(() => '');
      lastError = new Error(
        `Nylas request failed (${response.status}) on ${baseUrl}: ${text || response.statusText}`
      );

      // If auth failed and we are in forced region mode, no point retrying another region.
      if (response.status === 401 && configuredNylasRegion) {
        throw lastError;
      }
    } catch (err) {
      // Network/TLS/DNS errors throw before any HTTP response — try next region in auto mode.
      const msg = formatFetchError(err);
      lastError = new Error(`Nylas fetch failed on ${baseUrl}: ${msg}`);
      if (configuredNylasRegion) {
        throw lastError;
      }
      continue;
    }
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
    const classification = classifyIncomingMessage({
      subject,
      body,
      fromEmail: fromAddresses.join(', '),
      toEmail: toAddresses.join(', '),
      rules: messageTypeRules,
    });
    const messageType = classification.messageType;
    const receivedAt = message?.date ? new Date(message.date * 1000) : null;
    const slackPayload = {
      emailAccount: emailRow.address,
      subject,
      from: fromAddresses.join(', '),
      to: toAddresses.join(', '),
      body,
    };

    const shouldSendSlack = messageType === 'interest' && !alreadyNotifiedIds.has(messageId);
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
          messageType,
          receivedAt,
        })
      );
    } catch (error) {
      if (error?.code !== '23505') {
        console.error('[NYLAS] Failed storing incoming message:', error.message || error);
      }
    }
  }
}

async function pollUnreadEmails() {
  if (isRunning) return;
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

    for (const emailRow of emailAccounts) {
      try {
        await fetchUnreadMessagesForMailbox(emailRow);
      } catch (error) {
        console.error(`[NYLAS] Failed polling ${emailRow.address}:`, error.message || error, {
          grantId: emailRow.grantId,
          nylasKey: emailRow.nylasKey,
        });
      }
    }
  } catch (error) {
    console.error('[NYLAS] Polling job failed:', error.message || error);
  } finally {
    isRunning = false;
  }
}

export function startNylasUnreadPollingJob() {
  if (timer) return;
  pollUnreadEmails().catch(() => undefined);
  timer = setInterval(() => {
    pollUnreadEmails().catch(() => undefined);
  }, POLL_MS);
  console.log('[NYLAS] Unread-email polling started (every 1 minute)');
}

