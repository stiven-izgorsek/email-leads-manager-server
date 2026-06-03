import { AppDataSource } from '../config/database.js';
import { Client } from '../entities/Client.js';
import { MarketingAssignmentLead } from '../entities/MarketingAssignmentLead.js';

/**
 * Count outbound emails in [rangeStart, rangeEndExclusive).
 * Nylas marketing sends: marketing_assignment_lead rows with send_status = 'sent'.
 * Gmail extension / manual sends: clients with isSent and lastSent in range, excluding
 * clients already counted via a marketing send in the same window (avoids double-count).
 */
export async function countOutboundEmailsInRange(rangeStart, rangeEndExclusive) {
  const malRepo = AppDataSource.getRepository(MarketingAssignmentLead);

  const marketingSends = await malRepo
    .createQueryBuilder('mal')
    .where('mal.sendStatus = :sent', { sent: 'sent' })
    .andWhere('mal.sentAt >= :rangeStart', { rangeStart })
    .andWhere('mal.sentAt < :rangeEndExclusive', { rangeEndExclusive })
    .getCount();

  const clientRepo = AppDataSource.getRepository(Client);
  const gmailOnlySends = await clientRepo
    .createQueryBuilder('client')
    .where('client.deletedAt IS NULL')
    .andWhere('client.isSent = :isSent', { isSent: true })
    .andWhere('client.lastSent >= :rangeStart', { rangeStart })
    .andWhere('client.lastSent < :rangeEndExclusive', { rangeEndExclusive })
    .andWhere(
      `NOT EXISTS (
        SELECT 1 FROM marketing_assignment_lead mal
        WHERE mal.client_id = client.id
          AND mal.send_status = 'sent'
          AND mal.sent_at >= :rangeStart
          AND mal.sent_at < :rangeEndExclusive
      )`
    )
    .getCount();

  return marketingSends + gmailOnlySends;
}
