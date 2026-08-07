import { AppDataSource } from '../config/database.js';
import { Email } from '../entities/Email.js';
import { CalendarEvent } from '../entities/CalendarEvent.js';
import { CrmClient } from '../entities/CrmClient.js';
import { serializeCrmClient } from '../controllers/crmClientController.js';
import {
  fetchPrimaryCalendarEvents,
  parseEventWhen,
  shouldIncludeCalendarEvent,
  extractMeetingDetails,
} from './nylasCalendarService.js';
import { sleep } from '../utils/nylasRateLimit.js';
import { listExpandedLocalEvents } from './localCalendarService.js';

const DEFAULT_SYNC_DAYS_BACK = 14;
const DEFAULT_SYNC_DAYS_FORWARD = 120;
const MAILBOX_STAGGER_MS = 300;

function parseSyncDaysBack() {
  const n = parseInt(process.env.CALENDAR_SYNC_DAYS_BACK || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SYNC_DAYS_BACK;
}

function parseSyncDaysForward() {
  const n = parseInt(process.env.CALENDAR_SYNC_DAYS_FORWARD || '', 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_SYNC_DAYS_FORWARD;
}

/** Default window for hourly cron sync. */
export function getDefaultCalendarSyncRange() {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - parseSyncDaysBack());
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setDate(end.getDate() + parseSyncDaysForward());
  end.setHours(23, 59, 59, 999);
  return {
    startSec: Math.floor(start.getTime() / 1000),
    endSec: Math.floor(end.getTime() / 1000),
    start,
    end,
  };
}

export function parseUnixRange(query) {
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

function collectEmailsFromStoredRow(row) {
  const set = new Set();
  if (row.organizerEmail) set.add(String(row.organizerEmail).trim().toLowerCase());
  const parts = Array.isArray(row.participantsJson) ? row.participantsJson : [];
  for (const p of parts) {
    if (p?.email) set.add(String(p.email).trim().toLowerCase());
  }
  return Array.from(set).filter(Boolean);
}

async function loadCrmClientMap(emails) {
  if (!emails.size) return new Map();
  const crmRepo = AppDataSource.getRepository(CrmClient);
  const list = Array.from(emails);
  const clients = await crmRepo
    .createQueryBuilder('c')
    .where('LOWER(c.email) IN (:...emails)', { emails: list })
    .getMany();
  return new Map(
    clients.map((c) => [String(c.email).trim().toLowerCase(), serializeCrmClient(c)])
  );
}

function normalizeEmailIds(emailId, emailIds) {
  const ids = new Set();
  if (Array.isArray(emailIds)) {
    for (const v of emailIds) {
      const t = String(v || '').trim();
      if (t) ids.add(t);
    }
  } else if (typeof emailIds === 'string' && emailIds.trim()) {
    for (const v of emailIds.split(',')) {
      const t = v.trim();
      if (t) ids.add(t);
    }
  }
  if (emailId) {
    const t = String(emailId).trim();
    if (t) ids.add(t);
  }
  return Array.from(ids);
}

async function getNylasMailboxes(emailIdList) {
  const emailRepo = AppDataSource.getRepository(Email);
  const qb = emailRepo
    .createQueryBuilder('email')
    .where('email.deletedAt IS NULL')
    .andWhere('email.grantId IS NOT NULL')
    .andWhere("TRIM(email.grantId) <> ''")
    .andWhere('email.nylasKey IS NOT NULL')
    .andWhere("TRIM(email.nylasKey) <> ''");

  if (Array.isArray(emailIdList) && emailIdList.length > 0) {
    qb.andWhere('email.id IN (:...ids)', { ids: emailIdList });
  }

  return qb.getMany();
}

function mapNylasEventToRow(ev, mailbox, whenParsed, syncedAt) {
  const participants = Array.isArray(ev.participants) ? ev.participants : [];
  const meeting = extractMeetingDetails(ev);
  return {
    emailId: mailbox.id,
    mailboxEmail: mailbox.address,
    grantId: mailbox.grantId,
    nylasEventId: String(ev.id),
    title: ev.title || '(no title)',
    description: typeof ev.description === 'string' ? ev.description : null,
    startAt: whenParsed.start,
    endAt: whenParsed.end,
    allDay: whenParsed.allDay,
    location: ev.location || null,
    htmlLink: ev.html_link || null,
    meetingUrl: meeting.url,
    meetingProvider: meeting.provider,
    eventStatus: ev.status || null,
    organizerName: ev.organizer?.name || null,
    organizerEmail: ev.organizer?.email || null,
    participantsJson: participants.map((p) => ({
      email: p?.email || '',
      name: p?.name || null,
      status: p?.status || null,
    })),
    syncedAt,
  };
}

function enrichParticipant(p, clientByEmail) {
  const em = p?.email ? String(p.email).trim().toLowerCase() : '';
  return {
    email: p?.email || '',
    name: p?.name || null,
    status: p?.status || null,
    crmClient: em ? clientByEmail.get(em) || null : null,
  };
}

function rowToApiEvent(row, clientByEmail) {
  const participants = Array.isArray(row.participantsJson) ? row.participantsJson : [];
  const enrichedParticipants = participants.map((p) => enrichParticipant(p, clientByEmail));

  const orgEmail = row.organizerEmail ? String(row.organizerEmail).trim().toLowerCase() : '';
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

  return {
    id: `${row.emailId}:${row.nylasEventId}`,
    source: 'nylas',
    nylasEventId: row.nylasEventId,
    grantId: row.grantId,
    mailboxId: row.emailId,
    mailboxEmail: row.mailboxEmail,
    title: row.title,
    description: row.description || null,
    start: row.startAt.toISOString(),
    end: row.endAt.toISOString(),
    allDay: row.allDay,
    location: row.location,
    htmlLink: row.htmlLink,
    meetingUrl: row.meetingUrl || null,
    meetingProvider: row.meetingProvider || null,
    status: row.eventStatus,
    organizer: row.organizerEmail || row.organizerName
      ? {
          name: row.organizerName,
          email: row.organizerEmail,
          crmClient: organizerClient,
        }
      : null,
    participants: enrichedParticipants,
    linkedClients,
  };
}

/**
 * Fetch from Nylas and upsert into calendar_event for the given range.
 */
export async function syncCalendarEventsFromNylas({ startSec, endSec, emailId, emailIds } = {}) {
  const rangeStart = new Date(startSec * 1000);
  const rangeEnd = new Date(endSec * 1000);
  const ids = normalizeEmailIds(emailId, emailIds);
  const mailboxes = await getNylasMailboxes(ids);
  const eventRepo = AppDataSource.getRepository(CalendarEvent);
  const syncedAt = new Date();
  const errors = [];
  let totalUpserted = 0;
  let totalRemoved = 0;

  for (let i = 0; i < mailboxes.length; i++) {
    const mailbox = mailboxes[i];
    if (i > 0) await sleep(MAILBOX_STAGGER_MS);

    const { events: rawEvents, error } = await fetchPrimaryCalendarEvents(
      mailbox.grantId,
      mailbox.nylasKey,
      startSec,
      endSec
    );

    if (error) {
      errors.push({
        mailboxId: mailbox.id,
        mailboxEmail: mailbox.address,
        message: error.message || String(error),
      });
      continue;
    }

    const rowsToSave = [];
    const keptNylasIds = new Set();

    for (const ev of rawEvents) {
      const whenParsed = parseEventWhen(ev.when);
      if (!shouldIncludeCalendarEvent(whenParsed)) continue;
      keptNylasIds.add(String(ev.id));
      rowsToSave.push(mapNylasEventToRow(ev, mailbox, whenParsed, syncedAt));
    }

    for (const row of rowsToSave) {
      const existing = await eventRepo.findOne({
        where: { emailId: mailbox.id, nylasEventId: row.nylasEventId },
      });
      if (existing) {
        // Platform soft-deleted: keep hidden; do not resurrect on sync
        if (existing.deletedAt) continue;
        await eventRepo.update({ id: existing.id }, row);
      } else {
        await eventRepo.save(eventRepo.create(row));
      }
      totalUpserted += 1;
    }

    const staleQb = eventRepo
      .createQueryBuilder('ce')
      .where('ce.email_id = :emailId', { emailId: mailbox.id })
      .andWhere('ce.start_at < :rangeEnd', { rangeEnd })
      .andWhere('ce.end_at > :rangeStart', { rangeStart })
      .andWhere('ce.deleted_at IS NULL');

    if (keptNylasIds.size > 0) {
      staleQb.andWhere('ce.nylas_event_id NOT IN (:...ids)', { ids: Array.from(keptNylasIds) });
    }

    const stale = await staleQb.getMany();
    if (stale.length) {
      await eventRepo.remove(stale);
      totalRemoved += stale.length;
    }
  }

  return {
    range: { start: rangeStart.toISOString(), end: rangeEnd.toISOString() },
    mailboxes: mailboxes.length,
    upserted: totalUpserted,
    removed: totalRemoved,
    errors,
    syncedAt: syncedAt.toISOString(),
  };
}

/**
 * Read cached events from DB for the visible range (no Nylas calls).
 */
export async function listCalendarEventsFromDb({ startSec, endSec, emailId, emailIds } = {}) {
  const rangeStart = new Date(startSec * 1000);
  const rangeEnd = new Date(endSec * 1000);
  const eventRepo = AppDataSource.getRepository(CalendarEvent);
  const ids = normalizeEmailIds(emailId, emailIds);

  const qb = eventRepo
    .createQueryBuilder('ce')
    .where('ce.start_at < :rangeEnd', { rangeEnd })
    .andWhere('ce.end_at > :rangeStart', { rangeStart })
    .andWhere('ce.all_day = false')
    .andWhere('ce.deleted_at IS NULL');

  if (ids.length > 0) {
    qb.andWhere('ce.email_id IN (:...ids)', { ids });
  }

  const rows = await qb.orderBy('ce.start_at', 'ASC').getMany();

  const allEmails = new Set();
  for (const row of rows) {
    for (const em of collectEmailsFromStoredRow(row)) {
      allEmails.add(em);
    }
  }
  const clientByEmail = await loadCrmClientMap(allEmails);

  const events = rows.map((row) => rowToApiEvent(row, clientByEmail));

  const localEvents = await listExpandedLocalEvents({
    startSec,
    endSec,
    emailIds: ids.length > 0 ? ids : undefined,
  });

  const merged = [...events, ...localEvents].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  const lastSynced = await eventRepo
    .createQueryBuilder('ce')
    .select('MAX(ce.synced_at)', 'max')
    .getRawOne();
  const lastSyncedAt = lastSynced?.max ? new Date(lastSynced.max).toISOString() : null;

  return {
    range: { start: rangeStart.toISOString(), end: rangeEnd.toISOString() },
    events: merged,
    errors: [],
    lastSyncedAt,
    fromCache: true,
  };
}

/**
 * Soft-delete a synced Nylas event in this platform only (does not cancel in Google/Nylas).
 * API id format: `${emailId}:${nylasEventId}`
 */
export async function softDeleteNylasCalendarEvent(apiId) {
  const raw = String(apiId || '').trim();
  const sep = raw.indexOf(':');
  if (sep <= 0 || sep >= raw.length - 1) {
    throw new Error('Invalid event id');
  }
  const emailId = raw.slice(0, sep);
  const nylasEventId = raw.slice(sep + 1);
  if (!emailId || !nylasEventId) {
    throw new Error('Invalid event id');
  }

  const eventRepo = AppDataSource.getRepository(CalendarEvent);
  const existing = await eventRepo.findOne({
    where: { emailId, nylasEventId },
  });
  if (!existing || existing.deletedAt) {
    throw new Error('Event not found');
  }

  await eventRepo.update({ id: existing.id }, { deletedAt: new Date() });
  return { deleted: true, source: 'nylas' };
}

/** Hourly job: sync default window for all mailboxes. */
export async function runScheduledCalendarSync() {
  const { startSec, endSec } = getDefaultCalendarSyncRange();
  console.log('[calendar-sync] Starting scheduled sync…');
  const result = await syncCalendarEventsFromNylas({ startSec, endSec });
  console.log(
    `[calendar-sync] Done: ${result.upserted} upserted, ${result.removed} removed, ${result.errors.length} error(s)`
  );
  return result;
}
