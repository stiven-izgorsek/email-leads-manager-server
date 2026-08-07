import { IsNull } from 'typeorm';
import { AppDataSource } from '../config/database.js';
import { IncomingMessage } from '../entities/IncomingMessage.js';
import { IncomingMessageReply } from '../entities/IncomingMessageReply.js';
import { Email } from '../entities/Email.js';
import { sendNylasEmail } from './nylasSendService.js';

function buildReplySubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return 'Re:';
  if (/^re:\s*/i.test(s)) return s;
  return `Re: ${s}`;
}

function extractEmailFromHeaderLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;
  const angle = raw.match(/<([^>]+@[^>]+)>/);
  const candidate = (angle?.[1] || raw).trim().toLowerCase();
  if (!/^[^\s<>]+@[^\s<>]+$/.test(candidate)) return null;
  return candidate;
}

function extractDisplayNameFromHeaderLine(line, fallbackEmail) {
  const raw = String(line || '').trim();
  if (!raw) return fallbackEmail || null;
  const angle = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (angle) {
    const name = angle[1].replace(/^["']|["']$/g, '').trim();
    return name || fallbackEmail || null;
  }
  return fallbackEmail || null;
}

function isHtmlBodyEmpty(html) {
  const raw = String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .trim();
  return !raw;
}

function mapStoredReply(row) {
  return {
    id: row.id,
    incomingMessageId: row.incomingMessageId,
    emailAddress: row.emailAddress,
    toEmail: row.toEmail,
    toName: row.toName || null,
    subject: row.subject || '',
    body: row.body || '',
    nylasMessageId: row.nylasMessageId || null,
    sentAt: row.sentAt instanceof Date ? row.sentAt.toISOString() : row.sentAt,
  };
}

export async function listManualRepliesForIncomingMessage(incomingMessageId) {
  const id = String(incomingMessageId || '').trim();
  if (!id) throw Object.assign(new Error('id is required'), { status: 400 });

  const incomingRepo = AppDataSource.getRepository(IncomingMessage);
  const incoming = await incomingRepo.findOne({ where: { id, deletedAt: IsNull() } });
  if (!incoming) throw Object.assign(new Error('Incoming message not found'), { status: 404 });

  const replyRepo = AppDataSource.getRepository(IncomingMessageReply);
  const rows = await replyRepo.find({
    where: { incomingMessageId: id },
    order: { sentAt: 'ASC', createdAt: 'ASC' },
  });

  return {
    incomingMessageId: id,
    replies: rows.map(mapStoredReply),
  };
}

export async function replyToIncomingMessageById(
  incomingMessageId,
  { body, subject: subjectOverride, toEmail: toEmailOverride, toName: toNameOverride } = {}
) {
  const id = String(incomingMessageId || '').trim();
  const replyBody = String(body || '').trim();
  if (!id) throw Object.assign(new Error('id is required'), { status: 400 });
  if (!replyBody || isHtmlBodyEmpty(replyBody)) {
    throw Object.assign(new Error('Reply body is required'), { status: 400 });
  }

  const incomingRepo = AppDataSource.getRepository(IncomingMessage);
  const incoming = await incomingRepo.findOne({ where: { id, deletedAt: IsNull() } });
  if (!incoming) throw Object.assign(new Error('Incoming message not found'), { status: 404 });

  const emailRepo = AppDataSource.getRepository(Email);
  const mailbox = await emailRepo.findOne({
    where: { address: incoming.emailAddress, deletedAt: null },
  });
  if (!mailbox?.grantId || !mailbox?.nylasKey) {
    throw Object.assign(new Error('Mailbox is missing Nylas credentials'), { status: 400 });
  }

  const resolvedTo =
    extractEmailFromHeaderLine(toEmailOverride) ||
    extractEmailFromHeaderLine(incoming.fromEmail);
  if (!resolvedTo) {
    throw Object.assign(new Error('Could not determine recipient address for this message'), { status: 400 });
  }

  const toName =
    String(toNameOverride || '').trim() ||
    extractDisplayNameFromHeaderLine(incoming.fromEmail, resolvedTo) ||
    resolvedTo;
  const subject = String(subjectOverride || '').trim() || buildReplySubject(incoming.subject);

  const result = await sendNylasEmail({
    grantId: mailbox.grantId,
    nylasKey: mailbox.nylasKey,
    toEmail: resolvedTo,
    toName,
    subject,
    body: replyBody,
    replyToMessageId: incoming.messageId,
  });

  if (!result.ok) {
    const err = Object.assign(new Error(result.error || 'Failed to send reply via Nylas'), { status: 502 });
    err.httpStatus = result.httpStatus;
    throw err;
  }

  const sentAt = new Date();
  const replyRepo = AppDataSource.getRepository(IncomingMessageReply);
  const saved = await replyRepo.save(
    replyRepo.create({
      incomingMessageId: incoming.id,
      emailAddress: incoming.emailAddress,
      toEmail: resolvedTo,
      toName,
      subject,
      body: replyBody,
      nylasMessageId: result.messageId || null,
      sentAt,
    })
  );

  return {
    ok: true,
    messageId: result.messageId,
    replyId: saved.id,
    toEmail: resolvedTo,
    subject,
    emailAddress: incoming.emailAddress,
    sentAt: sentAt.toISOString(),
  };
}
