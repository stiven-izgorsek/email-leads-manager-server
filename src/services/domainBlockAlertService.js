import { AppDataSource } from '../config/database.js';
import { Email } from '../entities/Email.js';
import { MarketingDomainBlockAlert } from '../entities/MarketingDomainBlockAlert.js';
import {
  setMarketingEnabled,
  stopMarketingForEmail,
  unassignAllPendingMarketingLeads,
} from './marketingService.js';

/**
 * Google Workspace / Gmail "Message blocked" domain-policy bounce
 * (e.g. support.google.com/a/answer/172179).
 */
export function isGoogleDomainPolicyBlock({ subject, body, fromEmail } = {}) {
  const text = `${subject || ''}\n${body || ''}\n${fromEmail || ''}`.toLowerCase();
  if (!text.trim()) return false;

  const hasMessageBlocked = /\bmessage\s+blocked\b/.test(text);
  const hasPolicy =
    /policy that prohibited/.test(text) ||
    /prohibited the mail that you sent/.test(text) ||
    /support\.google\.com\/a\/answer\/172179/.test(text) ||
    /550[\s\-]?5\.7\.1/.test(text);

  if (hasMessageBlocked && hasPolicy) return true;
  // Strong signals even without exact "Message blocked" subject
  if (/support\.google\.com\/a\/answer\/172179/.test(text) && /prohibited/.test(text)) {
    return true;
  }
  return false;
}

function snippetFromBody(body, max = 280) {
  const s = String(body || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Create a pending alert when a Google domain-policy block is received for a mailbox.
 * Idempotent per (emailAddress, externalMessageId).
 */
export async function maybeCreateDomainBlockAlert({
  mailboxAddress,
  externalMessageId,
  incomingMessageId = null,
  subject = null,
  body = null,
  fromEmail = null,
}) {
  if (!isGoogleDomainPolicyBlock({ subject, body, fromEmail })) {
    return null;
  }

  const address = String(mailboxAddress || '').trim().toLowerCase();
  if (!address) return null;

  const emailRepo = AppDataSource.getRepository(Email);
  const email = await emailRepo
    .createQueryBuilder('email')
    .where('email.deletedAt IS NULL')
    .andWhere('LOWER(TRIM(email.address)) = :address', { address })
    .getOne();

  if (!email) {
    console.warn('[domain-block] mailbox not found for alert:', address);
    return null;
  }

  const alertRepo = AppDataSource.getRepository(MarketingDomainBlockAlert);
  const extId = externalMessageId ? String(externalMessageId).trim() : null;

  if (extId) {
    const existing = await alertRepo.findOne({
      where: { emailAddress: address, externalMessageId: extId },
    });
    if (existing) return existing;
  }

  // Also avoid stacking many pending alerts for same mailbox
  const pendingSame = await alertRepo.findOne({
    where: { emailId: email.id, status: 'pending' },
  });
  if (pendingSame) {
    return pendingSame;
  }

  try {
    const row = alertRepo.create({
      emailId: email.id,
      emailAddress: address,
      incomingMessageId: incomingMessageId || null,
      externalMessageId: extId,
      subject: subject ? String(subject).slice(0, 1000) : null,
      snippet: snippetFromBody(body),
      status: 'pending',
    });
    const saved = await alertRepo.save(row);
    console.log('[domain-block] alert created', {
      alertId: saved.id,
      email: address,
      subject: saved.subject,
    });
    return saved;
  } catch (err) {
    if (err?.code === '23505') {
      return alertRepo.findOne({
        where: { emailAddress: address, externalMessageId: extId },
      });
    }
    throw err;
  }
}

export async function listPendingDomainBlockAlerts() {
  const rows = await AppDataSource.getRepository(MarketingDomainBlockAlert).find({
    where: { status: 'pending' },
    order: { createdAt: 'DESC' },
    take: 20,
  });
  return rows.map((r) => ({
    id: r.id,
    emailId: r.emailId,
    emailAddress: r.emailAddress,
    incomingMessageId: r.incomingMessageId,
    externalMessageId: r.externalMessageId,
    subject: r.subject,
    snippet: r.snippet,
    status: r.status,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
  }));
}

export async function dismissDomainBlockAlert(alertId) {
  const repo = AppDataSource.getRepository(MarketingDomainBlockAlert);
  const row = await repo.findOne({ where: { id: alertId } });
  if (!row) throw new Error('Alert not found');
  if (row.status !== 'pending') return serializeAlert(row);
  row.status = 'dismissed';
  row.acknowledgedAt = new Date();
  await repo.save(row);
  return serializeAlert(row);
}

/**
 * Confirm: stop mid-run, disable marketing, unassign pending for the date.
 */
export async function confirmStopForDomainBlockAlert(alertId, assignmentDate) {
  const repo = AppDataSource.getRepository(MarketingDomainBlockAlert);
  const row = await repo.findOne({ where: { id: alertId } });
  if (!row) throw new Error('Alert not found');

  const stopResult = await stopMarketingForEmail(row.emailId, assignmentDate);
  await setMarketingEnabled(row.emailId, false);
  const unassignResult = await unassignAllPendingMarketingLeads({
    assignmentDate,
    emailId: row.emailId,
  });

  row.status = 'confirmed';
  row.acknowledgedAt = new Date();
  await repo.save(row);

  return {
    alert: serializeAlert(row),
    stop: stopResult,
    unassigned: unassignResult?.unassigned ?? 0,
    marketingEnabled: false,
  };
}

function serializeAlert(r) {
  return {
    id: r.id,
    emailId: r.emailId,
    emailAddress: r.emailAddress,
    incomingMessageId: r.incomingMessageId,
    externalMessageId: r.externalMessageId,
    subject: r.subject,
    snippet: r.snippet,
    status: r.status,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    acknowledgedAt:
      r.acknowledgedAt instanceof Date ? r.acknowledgedAt.toISOString() : r.acknowledgedAt,
  };
}
