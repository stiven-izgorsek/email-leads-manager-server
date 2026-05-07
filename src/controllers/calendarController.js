import { AppDataSource } from '../config/database.js';
import { Email } from '../entities/Email.js';
import { CrmClient } from '../entities/CrmClient.js';
import { serializeCrmClient } from './crmClientController.js';
import {
  fetchPrimaryCalendarEvents,
  parseEventWhen,
} from '../services/nylasCalendarService.js';

function parseUnixRange(query) {
  let startSec = query.start != null ? Number(query.start) : NaN;
  let endSec = query.end != null ? Number(query.end) : NaN;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    const startIso = query.startDate || query.from;
    const endIso = query.endDate || query.to;
    if (startIso && endIso) {
      const s = new Date(String(startIso));
      const e = new Date(String(endIso));
      if (!Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime())) {
        startSec = Math.floor(s.getTime() / 1000);
        endSec = Math.floor(e.getTime() / 1000);
      }
    }
  }
  return { startSec, endSec };
}

function collectEmailsFromEvent(ev) {
  const set = new Set();
  const org = ev?.organizer;
  if (org?.email) set.add(String(org.email).trim().toLowerCase());
  const participants = Array.isArray(ev?.participants) ? ev.participants : [];
  for (const p of participants) {
    if (p?.email) set.add(String(p.email).trim().toLowerCase());
  }
  return Array.from(set).filter(Boolean);
}

export async function listCalendarEvents(req, res) {
  try {
    const { startSec: rawStart, endSec: rawEnd } = parseUnixRange(req.query);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      return res.status(400).json({
        error:
          'Provide start and end as Unix seconds (?start=&end=) or ISO (?startDate=&endDate=)',
      });
    }
    if (rawEnd < rawStart) {
      return res.status(400).json({ error: 'end must be >= start' });
    }

    const maxSpanSec = 366 * 24 * 60 * 60;
    if (rawEnd - rawStart > maxSpanSec) {
      return res.status(400).json({ error: 'Date range cannot exceed ~366 days' });
    }

    const emailRepo = AppDataSource.getRepository(Email);
    const qb = emailRepo
      .createQueryBuilder('email')
      .where('email.deletedAt IS NULL')
      .andWhere('email.grantId IS NOT NULL')
      .andWhere("TRIM(email.grantId) <> ''")
      .andWhere('email.nylasKey IS NOT NULL')
      .andWhere("TRIM(email.nylasKey) <> ''");

    const emailId = (req.query.emailId || '').trim();
    if (emailId) {
      qb.andWhere('email.id = :emailId', { emailId });
    }

    const mailboxes = await qb.getMany();
    if (!mailboxes.length) {
      return res.json({
        success: true,
        range: {
          start: new Date(rawStart * 1000).toISOString(),
          end: new Date(rawEnd * 1000).toISOString(),
        },
        events: [],
        errors: [],
      });
    }

    const errors = [];
    const rawEvents = [];

    for (const row of mailboxes) {
      const { events, error } = await fetchPrimaryCalendarEvents(
        row.grantId,
        row.nylasKey,
        rawStart,
        rawEnd
      );
      if (error) {
        errors.push({
          mailboxId: row.id,
          mailboxEmail: row.address,
          message: error.message || String(error),
        });
        continue;
      }
      for (const ev of events) {
        rawEvents.push({ ev, mailbox: row });
      }
    }

    const allEmails = new Set();
    for (const { ev } of rawEvents) {
      for (const em of collectEmailsFromEvent(ev)) {
        allEmails.add(em);
      }
    }

    let clientByEmail = new Map();
    if (allEmails.size > 0) {
      const crmRepo = AppDataSource.getRepository(CrmClient);
      const list = Array.from(allEmails);
      const clients = await crmRepo
        .createQueryBuilder('c')
        .where('LOWER(c.email) IN (:...emails)', { emails: list })
        .getMany();
      clientByEmail = new Map(
        clients.map((c) => [String(c.email).trim().toLowerCase(), serializeCrmClient(c)])
      );
    }

    const events = [];

    for (const { ev, mailbox } of rawEvents) {
      const whenParsed = parseEventWhen(ev.when);
      if (!whenParsed) continue;

      const participants = Array.isArray(ev.participants) ? ev.participants : [];
      const enrichedParticipants = participants.map((p) => {
        const em = p?.email ? String(p.email).trim().toLowerCase() : '';
        return {
          email: p?.email || '',
          name: p?.name || null,
          status: p?.status || null,
          crmClient: em ? clientByEmail.get(em) || null : null,
        };
      });

      const orgEmail = ev.organizer?.email
        ? String(ev.organizer.email).trim().toLowerCase()
        : '';
      const organizerClient = orgEmail ? clientByEmail.get(orgEmail) || null : null;

      const linkedClients = [];
      const seenId = new Set();
      for (const p of enrichedParticipants) {
        if (p.crmClient?.id && !seenId.has(p.crmClient.id)) {
          seenId.add(p.crmClient.id);
          linkedClients.push(p.crmClient);
        }
      }
      if (organizerClient?.id && !seenId.has(organizerClient.id)) {
        linkedClients.push(organizerClient);
      }

      events.push({
        id: `${mailbox.id}:${ev.id}`,
        nylasEventId: ev.id,
        grantId: mailbox.grantId,
        mailboxId: mailbox.id,
        mailboxEmail: mailbox.address,
        title: ev.title || '(no title)',
        start: whenParsed.start.toISOString(),
        end: whenParsed.end.toISOString(),
        allDay: whenParsed.allDay,
        location: ev.location || null,
        htmlLink: ev.html_link || null,
        status: ev.status || null,
        organizer: ev.organizer
          ? {
              name: ev.organizer.name || null,
              email: ev.organizer.email || null,
              crmClient: organizerClient,
            }
          : null,
        participants: enrichedParticipants,
        linkedClients,
      });
    }

    events.sort((a, b) => new Date(a.start) - new Date(b.start));

    return res.json({
      success: true,
      range: {
        start: new Date(rawStart * 1000).toISOString(),
        end: new Date(rawEnd * 1000).toISOString(),
      },
      events,
      errors,
    });
  } catch (error) {
    console.error('listCalendarEvents error:', error);
    return res.status(500).json({ error: error.message || 'Failed to load calendar events' });
  }
}
