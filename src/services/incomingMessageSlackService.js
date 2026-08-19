import { IsNull } from 'typeorm';
import { AppDataSource } from '../config/database.js';
import { IncomingMessage } from '../entities/IncomingMessage.js';
import { Email } from '../entities/Email.js';
import { getNylasBaseUrls } from './nylasCalendarService.js';
import { nylasFetchWithRetry } from '../utils/nylasRateLimit.js';

const SLACK_WEBHOOK_URL = String(process.env.SLACK_INCOMING_MESSAGES_WEBHOOK || '').trim();
const SLACK_CHANNEL = '#incoming-messages';

function decodeHtmlEntities(text) {
  return String(text || '')
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

function extractNylasMessageBody(message) {
  if (!message) return '';
  const b = message.body;
  if (typeof b === 'string') return b;
  if (b != null && typeof b === 'object') {
    if (typeof b.value === 'string') return b.value;
    if (typeof b.content === 'string') return b.content;
  }
  return '';
}

function normalizeList(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === 'string') return item;
      const name = String(item?.name || '').trim();
      const email = String(item?.email || '').trim();
      if (name && email) return `${name} <${email}>`;
      return email || '';
    })
    .filter(Boolean);
}

async function fetchNylasMessageById(grantId, nylasKey, messageId) {
  const gid = String(grantId || '').trim();
  const key = String(nylasKey || '').trim();
  const mid = String(messageId || '').trim();
  if (!gid || !key || !mid) return null;

  for (const baseUrl of getNylasBaseUrls()) {
    const url = `${baseUrl}/v3/grants/${encodeURIComponent(gid)}/messages/${encodeURIComponent(mid)}`;
    try {
      const { response, text } = await nylasFetchWithRetry(
        url,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
          },
        },
        { label: 'incoming-slack-fetch' }
      );
      if (!response.ok) continue;
      const payload = text ? JSON.parse(text) : null;
      return payload?.data || payload || null;
    } catch {
      // try next region
    }
  }
  return null;
}

async function resolveIncomingMessagePayload(incoming) {
  const source = String(incoming.source || 'nylas').toLowerCase();
  if (source === 'app_password') {
    return {
      emailAccount: incoming.emailAddress,
      subject: incoming.subject || '(no subject)',
      from: incoming.fromEmail || '-',
      to: incoming.toEmail || '-',
      body: incoming.bodyHtml || incoming.bodyText || '',
      sourceLabel: 'App Password (IMAP)',
    };
  }

  const localBody = incoming.bodyHtml || incoming.bodyText || '';
  if (localBody) {
    return {
      emailAccount: incoming.emailAddress,
      subject: incoming.subject || '(no subject)',
      from: incoming.fromEmail || '-',
      to: incoming.toEmail || '-',
      body: localBody,
      sourceLabel: 'Nylas',
    };
  }

  const emailRepo = AppDataSource.getRepository(Email);
  const mailbox = await emailRepo.findOne({
    where: { address: incoming.emailAddress, deletedAt: null },
  });
  if (!mailbox?.grantId || !mailbox?.nylasKey) {
    const err = new Error('Mailbox is missing Nylas credentials');
    err.status = 400;
    throw err;
  }

  const message = await fetchNylasMessageById(mailbox.grantId, mailbox.nylasKey, incoming.messageId);
  if (!message) {
    const err = new Error('Message not found in Nylas');
    err.status = 404;
    throw err;
  }

  const fromList = normalizeList(message.from);
  const toList = normalizeList(message.to);
  return {
    emailAccount: incoming.emailAddress,
    subject: message.subject || incoming.subject || '(no subject)',
    from: fromList.join(', ') || incoming.fromEmail || '-',
    to: toList.join(', ') || incoming.toEmail || '-',
    body: extractNylasMessageBody(message) || message.snippet || '',
    sourceLabel: 'Nylas',
  };
}

async function postIncomingMessageToSlack(payload) {
  if (!SLACK_WEBHOOK_URL) {
    const err = new Error(
      'Slack webhook is not configured (set SLACK_INCOMING_MESSAGES_WEBHOOK)'
    );
    err.status = 400;
    throw err;
  }

  const readableBody = normalizeSlackMessageText(limitTextLength(htmlToReadableText(payload.body)));
  const text =
    `*Incoming email (manual notify)*\n` +
    `*Mailbox:* ${payload.emailAccount}\n` +
    `*Source:* ${payload.sourceLabel || '-'}\n` +
    `*From:* ${payload.from || '-'}\n` +
    `*To:* ${payload.to || '-'}\n` +
    `*Subject:* ${payload.subject || '(no subject)'}\n` +
    `*Message:*\n${readableBody || '-'}`;

  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: SLACK_CHANNEL,
      text,
    }),
  });

  if (!response.ok) {
    const respText = await response.text().catch(() => '');
    throw new Error(`Slack webhook failed (${response.status}): ${respText || response.statusText}`);
  }
}

/**
 * Load an incoming message and post it to #incoming-messages.
 * @param {string} incomingMessageId
 */
export async function notifyIncomingMessageToSlack(incomingMessageId) {
  const id = String(incomingMessageId || '').trim();
  if (!id) {
    const err = new Error('Incoming message id is required');
    err.status = 400;
    throw err;
  }

  const repo = AppDataSource.getRepository(IncomingMessage);
  const incoming = await repo.findOne({ where: { id, deletedAt: IsNull() } });
  if (!incoming) {
    const err = new Error('Incoming message not found');
    err.status = 404;
    throw err;
  }

  const payload = await resolveIncomingMessagePayload(incoming);
  await postIncomingMessageToSlack(payload);
  return {
    success: true,
    notified: true,
    id: incoming.id,
    channel: SLACK_CHANNEL,
  };
}
