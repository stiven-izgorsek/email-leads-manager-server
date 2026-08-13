import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { AppDataSource } from '../config/database.js';
import { Email } from '../entities/Email.js';
import { IncomingMessage } from '../entities/IncomingMessage.js';
import { NylasSlackNotification } from '../entities/NylasSlackNotification.js';
import { In } from 'typeorm';
import {
  classifyIncomingMessage,
  ensureDefaultMessageTypeRules,
  loadMessageTypeRules,
} from './messageTypeService.js';
import { maybeCreateDomainBlockAlert } from './domainBlockAlertService.js';
import {
  isIgnoredMarketingSender,
  isHiddenSender,
  MESSAGE_TYPE_IGNORED_SENDER,
  MESSAGE_TYPE_HIDE_SENDER,
} from './incomingSenderFilterService.js';

const POLL_MS = Math.min(
  30 * 60 * 1000,
  Math.max(30_000, parseInt(process.env.IMAP_POLL_MS || '', 10) || 60 * 1000)
);
const POLL_STAGGER_MS = Math.min(
  10_000,
  Math.max(0, parseInt(process.env.IMAP_POLL_STAGGER_MS || '500', 10) || 500)
);
const SLACK_WEBHOOK_URL = process.env.SLACK_INCOMING_MESSAGES_WEBHOOK || '';

let timer = null;
let isRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLocalDayBounds() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
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
  return decodeHtmlEntities(noTags)
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

function isWarmupTokenSubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return false;
  return /\|\s*[A-Z0-9]{5,}\s+[A-Z0-9]{5,}\s*$/.test(s);
}

async function sendMessageToSlack({ emailAccount, subject, from, to, body }) {
  if (!SLACK_WEBHOOK_URL) return;
  const readableBody = limitTextLength(htmlToReadableText(body));
  const text =
    `*New incoming email (App Password)*\n` +
    `*Mailbox:* ${emailAccount}\n` +
    `*From:* ${from || '-'}\n` +
    `*To:* ${to || '-'}\n` +
    `*Subject:* ${subject || '(no subject)'}\n` +
    `*Message:*\n${readableBody || '-'}`;

  const response = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: '#incoming-messages', text }),
  });
  if (!response.ok) {
    const respText = await response.text().catch(() => '');
    throw new Error(`Slack webhook failed (${response.status}): ${respText || response.statusText}`);
  }
}

function extractAddressList(value) {
  if (!value) return [];
  if (Array.isArray(value?.value)) {
    return value.value.map((v) => String(v.address || '').trim().toLowerCase()).filter(Boolean);
  }
  if (typeof value === 'string') {
    const m = value.match(/[\w.+-]+@[\w.-]+\.\w+/g);
    return m ? m.map((e) => e.toLowerCase()) : [];
  }
  return [];
}

function stableMessageId(parsed, mailbox, uid) {
  const mid = String(parsed?.messageId || '').trim();
  if (mid) return mid.slice(0, 250);
  return `imap:${String(mailbox || '').toLowerCase()}:${uid}`;
}

async function safeCloseImapClient(client) {
  if (!client) return;
  try {
    if (client.usable) {
      await client.logout();
      return;
    }
  } catch {
    // fall through to force-close
  }
  try {
    client.close();
  } catch {
    // ignore
  }
}

/**
 * Attach a no-op-safe error listener immediately — ImapFlow emits EventEmitter
 * 'error' on socket timeouts; without a listener Node crashes the whole process.
 */
function attachImapErrorHandler(client, mailbox) {
  client.on('error', (err) => {
    const code = err?.code || err?.responseCode || '';
    console.error(
      `[IMAP] ${mailbox}: ${err?.message || err}${code ? ` (${code})` : ''}`
    );
  });
}

async function fetchUnreadMessagesForMailbox(emailRow) {
  const user = String(emailRow.address || '').trim();
  const pass = String(emailRow.appPassword || '').trim();
  if (!user || !pass) return;

  const { start, end } = getLocalDayBounds();
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
    // Prefer IPv4 — same ENETUNREACH issue as SMTP on IPv6-broken networks
    family: 4,
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
    socketTimeout: 90_000,
  });
  attachImapErrorHandler(client, user);

  const incomingRepo = AppDataSource.getRepository(IncomingMessage);
  const notificationRepo = AppDataSource.getRepository(NylasSlackNotification);
  const messageTypeRules = await loadMessageTypeRules();

  try {
    await client.connect();
  } catch (err) {
    const details = [
      err?.responseText,
      err?.serverResponseCode,
      err?.authenticationFailed ? 'auth_failed' : null,
      err?.responseStatus,
      err?.code,
    ]
      .filter(Boolean)
      .join(' | ');
    console.error(
      `[IMAP] Connect failed for ${user}:`,
      err?.message || err,
      details ? `(${details})` : ''
    );
    await safeCloseImapClient(client);
    return;
  }

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Unread messages received today (local day).
      const uids = await client.search({
        seen: false,
        since: start,
      });
      if (!uids?.length) return;

      for await (const msg of client.fetch(uids, { source: true, uid: true, envelope: true })) {
        if (!msg?.source) continue;
        let parsed;
        try {
          parsed = await simpleParser(msg.source);
        } catch (err) {
          console.error(`[IMAP] Parse failed for ${user} uid=${msg.uid}:`, err.message || err);
          continue;
        }

        const receivedAt = parsed.date instanceof Date ? parsed.date : null;
        if (receivedAt && (receivedAt < start || receivedAt >= end)) {
          // Extra guard when SEARCH since is loose around midnight.
          continue;
        }

        const messageId = stableMessageId(parsed, user, msg.uid);
        const existing = await incomingRepo.findOne({
          where: { emailAddress: user, messageId },
        });
        if (existing) continue;

        const fromAddresses = extractAddressList(parsed.from);
        const toAddresses = extractAddressList(parsed.to);
        const subject = parsed.subject || '(no subject)';
        const bodyHtml = parsed.html ? String(parsed.html) : null;
        const bodyText =
          (parsed.text && String(parsed.text)) ||
          (bodyHtml ? htmlToReadableText(bodyHtml) : '') ||
          '';
        const bodyForClassify = bodyHtml || bodyText;

        if (await isHiddenSender(fromAddresses)) {
          try {
            await incomingRepo.save(
              incomingRepo.create({
                emailAddress: user,
                messageId,
                subject,
                fromEmail: fromAddresses[0] || null,
                toEmail: toAddresses[0] || null,
                messageType: MESSAGE_TYPE_HIDE_SENDER,
                receivedAt,
                isRead: true,
                source: 'app_password',
                bodyHtml,
                bodyText: bodyText || null,
              })
            );
          } catch (error) {
            if (error?.code !== '23505') {
              console.error('[IMAP] Failed storing hide-sender message:', error.message || error);
            }
          }
          continue;
        }

        if (isIgnoredMarketingSender(fromAddresses)) {
          try {
            await incomingRepo.save(
              incomingRepo.create({
                emailAddress: user,
                messageId,
                subject,
                fromEmail: fromAddresses[0] || null,
                toEmail: toAddresses[0] || null,
                messageType: MESSAGE_TYPE_IGNORED_SENDER,
                receivedAt,
                isRead: false,
                source: 'app_password',
                bodyHtml,
                bodyText: bodyText || null,
              })
            );
          } catch (error) {
            if (error?.code !== '23505') {
              console.error('[IMAP] Failed storing ignored-sender message:', error.message || error);
            }
          }
          continue;
        }

        const classification = await classifyIncomingMessage({
          subject,
          body: bodyForClassify,
          fromEmail: fromAddresses.join(', '),
          toEmail: toAddresses.join(', '),
          rules: messageTypeRules,
        });
        const messageType = classification.messageType;

        const alreadyNotified = await notificationRepo.findOne({
          where: { emailAddress: user, messageId },
        });
        const shouldSendSlack =
          messageType === 'interest' && !isWarmupTokenSubject(subject) && !alreadyNotified;
        if (shouldSendSlack) {
          try {
            await sendMessageToSlack({
              emailAccount: user,
              subject,
              from: fromAddresses.join(', '),
              to: toAddresses.join(', '),
              body: bodyForClassify,
            });
            await notificationRepo.save(
              notificationRepo.create({ emailAddress: user, messageId })
            );
          } catch (error) {
            if (error?.code !== '23505') {
              console.error('[IMAP] Slack/notify failed:', error.message || error);
            }
          }
        }

        try {
          await incomingRepo.save(
            incomingRepo.create({
              emailAddress: user,
              messageId,
              subject,
              fromEmail: fromAddresses[0] || null,
              toEmail: toAddresses[0] || null,
              messageType,
              receivedAt,
              isRead: false,
              source: 'app_password',
              bodyHtml,
              bodyText: bodyText || null,
            })
          );
        } catch (error) {
          if (error?.code !== '23505') {
            console.error('[IMAP] Failed storing incoming message:', error.message || error);
          }
        }

        try {
          await maybeCreateDomainBlockAlert({
            mailboxAddress: user,
            externalMessageId: messageId,
            subject,
            body: bodyForClassify,
            fromEmail: fromAddresses.join(', '),
          });
        } catch (error) {
          console.error('[IMAP] Domain-block alert failed:', error.message || error);
        }
      }
    } finally {
      try {
        lock.release();
      } catch {
        // mailbox may already be closed after a socket timeout
      }
    }
  } finally {
    await safeCloseImapClient(client);
  }
}

async function pollImapUnreadEmails() {
  if (isRunning) return;
  isRunning = true;

  try {
    await ensureDefaultMessageTypeRules();
    const emailRepository = AppDataSource.getRepository(Email);
    const emailAccounts = await emailRepository
      .createQueryBuilder('email')
      .where('email.deletedAt IS NULL')
      .andWhere('email.app_password IS NOT NULL')
      .andWhere("TRIM(email.app_password) <> ''")
      .getMany();

    for (let i = 0; i < emailAccounts.length; i += 1) {
      const emailRow = emailAccounts[i];
      try {
        await fetchUnreadMessagesForMailbox(emailRow);
      } catch (error) {
        console.error(`[IMAP] Failed polling ${emailRow.address}:`, error.message || error);
      }
      if (POLL_STAGGER_MS > 0 && i < emailAccounts.length - 1) {
        await sleep(POLL_STAGGER_MS);
      }
    }
  } catch (error) {
    console.error('[IMAP] Polling job failed:', error.message || error);
  } finally {
    isRunning = false;
  }
}

export function startImapUnreadPollingJob() {
  if (timer) return;
  pollImapUnreadEmails().catch(() => undefined);
  timer = setInterval(() => {
    pollImapUnreadEmails().catch(() => undefined);
  }, POLL_MS);
  console.log(`[IMAP] App-password unread polling started (every ${Math.round(POLL_MS / 1000)}s)`);
}
