import { AppDataSource } from '../config/database.js';
import { Client } from '../entities/Client.js';
import { MarketingAssignmentLead } from '../entities/MarketingAssignmentLead.js';

export function getLocalTodayRange() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return { today, tomorrow };
}

function parseSentByMailboxes(sentBy) {
  if (!sentBy) return [];
  if (Array.isArray(sentBy)) {
    return sentBy.map((s) => String(s || '').trim().toLowerCase()).filter((s) => s.includes('@'));
  }
  return String(sentBy)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes('@'));
}

function emptyStats() {
  return {
    nylasMarketingToday: 0,
    gmailExtensionToday: 0,
    followupsSentToday: 0,
    messagesSentToday: 0,
  };
}

/**
 * Per-mailbox outbound counts for today (local server timezone).
 * @param {Array<{ id: string, address: string }>} emails
 * @returns {Map<string, { nylasMarketingToday, gmailExtensionToday, followupsSentToday, messagesSentToday }>}
 */
export async function getMailboxTodayStatsByEmailId(emails) {
  const { today, tomorrow } = getLocalTodayRange();
  const map = new Map();
  const addressToEmailId = new Map();

  for (const email of emails || []) {
    const id = email.id;
    const addr = String(email.address || '').trim().toLowerCase();
    if (!id || !addr) continue;
    map.set(id, emptyStats());
    addressToEmailId.set(addr, id);
  }

  const malRepo = AppDataSource.getRepository(MarketingAssignmentLead);
  const nylasRows = await malRepo
    .createQueryBuilder('mal')
    .innerJoin('mal.assignment', 'ma')
    .select('ma.emailId', 'emailId')
    .addSelect('mal.clientId', 'clientId')
    .where('mal.sendStatus = :sent', { sent: 'sent' })
    .andWhere('mal.sentAt >= :today', { today })
    .andWhere('mal.sentAt < :tomorrow', { tomorrow })
    .getRawMany();

  const nylasClientIdsToday = new Set();
  const nylasCountByEmail = new Map();
  for (const row of nylasRows) {
    const emailId = row.emailId;
    if (!emailId || !map.has(emailId)) continue;
    nylasClientIdsToday.add(row.clientId);
    nylasCountByEmail.set(emailId, (nylasCountByEmail.get(emailId) || 0) + 1);
  }
  for (const [emailId, n] of nylasCountByEmail) {
    const entry = map.get(emailId);
    entry.nylasMarketingToday = n;
    entry.messagesSentToday += n;
  }

  const clientRepo = AppDataSource.getRepository(Client);
  const clients = await clientRepo
    .createQueryBuilder('client')
    .select(['client.id', 'client.sentBy', 'client.isSent', 'client.isFollowup'])
    .where('client.deletedAt IS NULL')
    .andWhere('client.lastSent >= :today', { today })
    .andWhere('client.lastSent < :tomorrow', { tomorrow })
    .getMany();

  for (const client of clients) {
    const mailboxes = parseSentByMailboxes(client.sentBy);
    if (!mailboxes.length) continue;

    const isFollowup = Boolean(client.isFollowup);
    const isSent = Boolean(client.isSent);
    const skipGmailBecauseNylas = nylasClientIdsToday.has(client.id);

    for (const mb of mailboxes) {
      const emailId = addressToEmailId.get(mb);
      if (!emailId) continue;
      const entry = map.get(emailId);
      if (isFollowup) {
        entry.followupsSentToday += 1;
      } else if (isSent && !skipGmailBecauseNylas) {
        entry.gmailExtensionToday += 1;
        entry.messagesSentToday += 1;
      }
    }
  }

  return map;
}
