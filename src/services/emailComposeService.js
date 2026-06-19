import { AppDataSource } from '../config/database.js';
import { Email } from '../entities/Email.js';
import { Client } from '../entities/Client.js';
import { CrmClient } from '../entities/CrmClient.js';
import { serializeCrmClient } from '../controllers/crmClientController.js';
import { sendNylasEmail } from './nylasSendService.js';

function normalizeEmailAddress(value) {
  return String(value || '').trim().toLowerCase();
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

function normalizeRecipientList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    let email = '';
    let name = null;
    if (typeof item === 'string') {
      email = normalizeEmailAddress(item);
    } else if (item && typeof item === 'object') {
      email = normalizeEmailAddress(item.email);
      name = item.name ? String(item.name).trim() : null;
    }
    if (!email || !/^[^\s<>]+@[^\s<>]+$/.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: name || email });
  }
  return out;
}

function mapLeadSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    companyName: row.companyName,
    companyUrl: row.companyUrl,
    jobTitle: row.jobTitle,
    status: row.status,
    location: row.location,
    companyLocation: row.companyLocation,
  };
}

export async function lookupRecipientsByEmails(emails) {
  const normalized = [
    ...new Set(
      (Array.isArray(emails) ? emails : String(emails || '').split(','))
        .map(normalizeEmailAddress)
        .filter(Boolean)
    ),
  ];
  if (!normalized.length) return [];

  const clientRepo = AppDataSource.getRepository(Client);
  const crmRepo = AppDataSource.getRepository(CrmClient);

  const [leads, crmClients] = await Promise.all([
    clientRepo
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL')
      .andWhere('LOWER(TRIM(COALESCE(client.email, \'\'))) IN (:...emails)', { emails: normalized })
      .getMany(),
    crmRepo
      .createQueryBuilder('c')
      .where('LOWER(TRIM(COALESCE(c.email, \'\'))) IN (:...emails)', { emails: normalized })
      .getMany(),
  ]);

  const leadByEmail = new Map(
    leads.map((row) => [normalizeEmailAddress(row.email), mapLeadSnapshot(row)])
  );
  const crmByEmail = new Map(
    crmClients.map((row) => [normalizeEmailAddress(row.email), serializeCrmClient(row)])
  );

  return normalized.map((email) => ({
    email,
    lead: leadByEmail.get(email) || null,
    crmClient: crmByEmail.get(email) || null,
  }));
}

export async function sendEmailFromMailbox(emailId, { to, cc, subject, body } = {}) {
  const id = String(emailId || '').trim();
  if (!id) throw Object.assign(new Error('Email id is required'), { status: 400 });

  const toRecipients = normalizeRecipientList(to);
  if (!toRecipients.length) {
    throw Object.assign(new Error('At least one To recipient is required'), { status: 400 });
  }

  const subjectText = String(subject || '').trim();
  const bodyHtml = String(body || '').trim();
  if (!subjectText) throw Object.assign(new Error('Subject is required'), { status: 400 });
  if (!bodyHtml || isHtmlBodyEmpty(bodyHtml)) {
    throw Object.assign(new Error('Message body is required'), { status: 400 });
  }

  const emailRepo = AppDataSource.getRepository(Email);
  const mailbox = await emailRepo.findOne({
    where: { id, deletedAt: null },
    relations: ['account'],
  });
  if (!mailbox) throw Object.assign(new Error('Email not found'), { status: 404 });
  if (!mailbox.grantId || !mailbox.nylasKey) {
    throw Object.assign(new Error('Mailbox is missing Nylas credentials'), { status: 400 });
  }

  const ccRecipients = normalizeRecipientList(cc);
  const result = await sendNylasEmail({
    grantId: mailbox.grantId,
    nylasKey: mailbox.nylasKey,
    toRecipients,
    ccRecipients,
    subject: subjectText,
    body: bodyHtml,
  });

  if (!result.ok) {
    const err = Object.assign(new Error(result.error || 'Failed to send email via Nylas'), { status: 502 });
    err.httpStatus = result.httpStatus;
    throw err;
  }

  return {
    ok: true,
    messageId: result.messageId,
    emailAddress: mailbox.address,
    to: toRecipients.map((r) => r.email),
    cc: ccRecipients.map((r) => r.email),
    subject: subjectText,
  };
}
