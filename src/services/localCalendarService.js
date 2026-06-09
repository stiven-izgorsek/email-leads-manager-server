import { AppDataSource } from '../config/database.js';
import { Email } from '../entities/Email.js';
import { CalendarEventLocal } from '../entities/CalendarEventLocal.js';
import { CalendarEventLocalException } from '../entities/CalendarEventLocalException.js';

const RECURRENCE_FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);
const MAX_OCCURRENCES = 500;

function parseDate(value, fieldName) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return d;
}

function normalizeRecurrence(body) {
  const freq = body?.recurrence?.frequency ?? body?.recurrenceFrequency ?? null;
  if (freq == null || freq === '' || freq === 'none') {
    return { recurrenceFrequency: null, recurrenceInterval: 1, recurrenceEndAt: null };
  }
  const key = String(freq).toLowerCase();
  if (!RECURRENCE_FREQUENCIES.has(key)) {
    throw new Error('recurrence.frequency must be daily, weekly, or monthly');
  }
  const interval = Number(body?.recurrence?.interval ?? body?.recurrenceInterval ?? 1);
  if (!Number.isFinite(interval) || interval < 1 || interval > 365) {
    throw new Error('recurrence.interval must be between 1 and 365');
  }
  const endRaw = body?.recurrence?.endDate ?? body?.recurrenceEndDate ?? body?.recurrenceEndAt ?? null;
  const recurrenceEndAt = endRaw ? parseDate(endRaw, 'recurrence end date') : null;
  return { recurrenceFrequency: key, recurrenceInterval: Math.floor(interval), recurrenceEndAt };
}

function occurrenceKey(d) {
  return new Date(d).toISOString();
}

function addRecurrenceStep(date, frequency, interval) {
  const next = new Date(date);
  if (frequency === 'daily') {
    next.setDate(next.getDate() + interval);
  } else if (frequency === 'weekly') {
    next.setDate(next.getDate() + 7 * interval);
  } else if (frequency === 'monthly') {
    next.setMonth(next.getMonth() + interval);
  }
  return next;
}

function findException(exceptions, originalStart) {
  const target = originalStart.getTime();
  return exceptions.find((ex) => new Date(ex.originalStartAt).getTime() === target) || null;
}

export function expandLocalEventOccurrences(master, exceptions, rangeStart, rangeEnd) {
  if (master.deletedAt) return [];

  const durationMs = new Date(master.endAt).getTime() - new Date(master.startAt).getTime();
  const results = [];
  const freq = master.recurrenceFrequency;
  const interval = master.recurrenceInterval || 1;
  const seriesEnd = master.recurrenceEndAt ? new Date(master.recurrenceEndAt) : null;

  if (!freq) {
    const start = new Date(master.startAt);
    const end = new Date(master.endAt);
    if (start < rangeEnd && end > rangeStart) {
      results.push({
        master,
        originalStart: start,
        start,
        end,
        exception: null,
      });
    }
    return results;
  }

  let current = new Date(master.startAt);
  let count = 0;

  if (freq && current < rangeStart) {
    while (current < rangeStart && count < MAX_OCCURRENCES) {
      if (seriesEnd && current > seriesEnd) return results;
      current = addRecurrenceStep(current, freq, interval);
      count += 1;
    }
  }

  while (count < MAX_OCCURRENCES) {
    if (seriesEnd && current > seriesEnd) break;
    if (current > rangeEnd) break;

    const end = new Date(current.getTime() + durationMs);
    const ex = findException(exceptions, current);

    if (end > rangeStart && current <= rangeEnd) {
      if (!ex?.isCancelled) {
        const startAt = ex?.startAt ? new Date(ex.startAt) : current;
        const endAt = ex?.endAt ? new Date(ex.endAt) : end;
        results.push({
          master,
          originalStart: current,
          start: startAt,
          end: endAt,
          exception: ex,
        });
      }
    }

    current = addRecurrenceStep(current, freq, interval);
    count += 1;
  }

  return results;
}

export function localOccurrenceToApiEvent(occurrence) {
  const { master, originalStart, start, end, exception } = occurrence;
  const isRecurring = Boolean(master.recurrenceFrequency);
  const id = isRecurring
    ? `local:${master.id}:${originalStart.getTime()}`
    : `local:${master.id}`;

  return {
    id,
    source: 'local',
    localEventId: master.id,
    occurrenceStart: isRecurring ? originalStart.toISOString() : null,
    nylasEventId: null,
    grantId: null,
    mailboxId: master.emailId,
    mailboxEmail: master.mailboxEmail,
    title: exception?.title || master.title,
    description: exception?.description ?? master.description ?? null,
    start: start.toISOString(),
    end: end.toISOString(),
    allDay: master.allDay,
    location: exception?.location ?? master.location ?? null,
    htmlLink: null,
    meetingUrl: null,
    meetingProvider: null,
    status: exception?.isCancelled ? 'cancelled' : null,
    recurrence: master.recurrenceFrequency
      ? {
          frequency: master.recurrenceFrequency,
          interval: master.recurrenceInterval || 1,
          endDate: master.recurrenceEndAt ? new Date(master.recurrenceEndAt).toISOString() : null,
        }
      : null,
    organizer: null,
    participants: [],
    linkedClients: [],
  };
}

async function getMailbox(emailId) {
  const emailRepo = AppDataSource.getRepository(Email);
  const mailbox = await emailRepo.findOne({ where: { id: emailId } });
  if (!mailbox || mailbox.deletedAt) {
    throw new Error('Mailbox not found');
  }
  return mailbox;
}

async function loadMasterOrThrow(id) {
  const repo = AppDataSource.getRepository(CalendarEventLocal);
  const master = await repo.findOne({ where: { id } });
  if (!master || master.deletedAt) {
    throw new Error('Local event not found');
  }
  return master;
}

async function loadExceptions(masterId) {
  const repo = AppDataSource.getRepository(CalendarEventLocalException);
  return repo.find({ where: { masterEventId: masterId } });
}

export async function listExpandedLocalEvents({ startSec, endSec, emailIds } = {}) {
  const rangeStart = new Date(startSec * 1000);
  const rangeEnd = new Date(endSec * 1000);
  const repo = AppDataSource.getRepository(CalendarEventLocal);
  const exRepo = AppDataSource.getRepository(CalendarEventLocalException);

  const qb = repo
    .createQueryBuilder('le')
    .where('le.deleted_at IS NULL')
    .andWhere('(le.recurrence_frequency IS NOT NULL OR (le.start_at < :rangeEnd AND le.end_at > :rangeStart))', {
      rangeStart,
      rangeEnd,
    });

  if (Array.isArray(emailIds) && emailIds.length > 0) {
    qb.andWhere('le.email_id IN (:...ids)', { ids: emailIds });
  }

  const masters = await qb.getMany();
  if (!masters.length) return [];

  const masterIds = masters.map((m) => m.id);
  const allExceptions = await exRepo
    .createQueryBuilder('ex')
    .where('ex.master_event_id IN (:...ids)', { ids: masterIds })
    .getMany();

  const exceptionsByMaster = new Map();
  for (const ex of allExceptions) {
    if (!exceptionsByMaster.has(ex.masterEventId)) {
      exceptionsByMaster.set(ex.masterEventId, []);
    }
    exceptionsByMaster.get(ex.masterEventId).push(ex);
  }

  const events = [];
  for (const master of masters) {
    const exceptions = exceptionsByMaster.get(master.id) || [];
    const occurrences = expandLocalEventOccurrences(master, exceptions, rangeStart, rangeEnd);
    for (const occ of occurrences) {
      events.push(localOccurrenceToApiEvent(occ));
    }
  }

  events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return events;
}

export async function createLocalCalendarEvent(body) {
  const emailId = String(body?.emailId || '').trim();
  if (!emailId) throw new Error('emailId is required');

  const startAt = parseDate(body?.start ?? body?.startAt, 'start');
  const endAt = parseDate(body?.end ?? body?.endAt, 'end');
  if (!startAt || !endAt) throw new Error('start and end are required');
  if (endAt <= startAt) throw new Error('end must be after start');

  const mailbox = await getMailbox(emailId);
  const recurrence = normalizeRecurrence(body);
  const repo = AppDataSource.getRepository(CalendarEventLocal);

  const row = repo.create({
    emailId: mailbox.id,
    mailboxEmail: mailbox.address,
    title: String(body?.title || '').trim() || '(no title)',
    description: body?.description != null ? String(body.description) : null,
    location: body?.location != null ? String(body.location).trim() || null : null,
    startAt,
    endAt,
    allDay: Boolean(body?.allDay),
    ...recurrence,
  });

  const saved = await repo.save(row);
  const exceptions = await loadExceptions(saved.id);
  const [occ] = expandLocalEventOccurrences(saved, exceptions, startAt, endAt);
  return {
    event: occ ? localOccurrenceToApiEvent(occ) : localOccurrenceToApiEvent({
      master: saved,
      originalStart: startAt,
      start: startAt,
      end: endAt,
      exception: null,
    }),
  };
}

export async function updateLocalCalendarEvent(id, body) {
  const master = await loadMasterOrThrow(id);
  const repo = AppDataSource.getRepository(CalendarEventLocal);

  const occurrenceStartRaw = body?.occurrenceStart ?? body?.originalStart ?? null;
  const scope = body?.scope || (occurrenceStartRaw ? 'occurrence' : 'series');

  if (scope === 'occurrence') {
    const originalStart = parseDate(occurrenceStartRaw, 'occurrenceStart');
    if (!master.recurrenceFrequency) {
      throw new Error('occurrenceStart is only valid for recurring events');
    }

    const exRepo = AppDataSource.getRepository(CalendarEventLocalException);
    const exceptions = await loadExceptions(master.id);
    let ex = findException(exceptions, originalStart);

    const patch = {
      isCancelled: false,
      title: body?.title != null ? String(body.title).trim() || '(no title)' : undefined,
      description: body?.description !== undefined ? (body.description != null ? String(body.description) : null) : undefined,
      location: body?.location !== undefined ? (body.location != null ? String(body.location).trim() || null : null) : undefined,
      startAt: body?.start ? parseDate(body.start, 'start') : undefined,
      endAt: body?.end ? parseDate(body.end, 'end') : undefined,
    };

    if (!ex) {
      ex = exRepo.create({
        masterEventId: master.id,
        originalStartAt: originalStart,
        ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
      });
    } else {
      Object.assign(ex, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      ex.isCancelled = false;
    }

    const savedEx = await exRepo.save(ex);
    const updatedExceptions = await loadExceptions(master.id);
    const occ = expandLocalEventOccurrences(master, updatedExceptions, originalStart, new Date(originalStart.getTime() + 86400000))
      .find((o) => o.originalStart.getTime() === originalStart.getTime());

    return {
      event: occ
        ? localOccurrenceToApiEvent(occ)
        : localOccurrenceToApiEvent({
            master,
            originalStart,
            start: savedEx.startAt || originalStart,
            end: savedEx.endAt || new Date(originalStart.getTime() + (new Date(master.endAt).getTime() - new Date(master.startAt).getTime())),
            exception: savedEx,
          }),
    };
  }

  const patch = {};
  if (body?.title != null) patch.title = String(body.title).trim() || '(no title)';
  if (body?.description !== undefined) patch.description = body.description != null ? String(body.description) : null;
  if (body?.location !== undefined) patch.location = body.location != null ? String(body.location).trim() || null : null;
  if (body?.start) patch.startAt = parseDate(body.start, 'start');
  if (body?.end) patch.endAt = parseDate(body.end, 'end');
  if (body?.allDay !== undefined) patch.allDay = Boolean(body.allDay);
  if (body?.emailId) {
    const mailbox = await getMailbox(String(body.emailId).trim());
    patch.emailId = mailbox.id;
    patch.mailboxEmail = mailbox.address;
  }

  if (body?.recurrence !== undefined || body?.recurrenceFrequency !== undefined) {
    Object.assign(patch, normalizeRecurrence(body));
  }

  if (patch.startAt && patch.endAt && patch.endAt <= patch.startAt) {
    throw new Error('end must be after start');
  }

  await repo.update({ id: master.id }, patch);
  const updated = await loadMasterOrThrow(master.id);
  const exceptions = await loadExceptions(updated.id);
  const start = patch.startAt || updated.startAt;
  const end = patch.endAt || updated.endAt;
  const [occ] = expandLocalEventOccurrences(updated, exceptions, start, end);

  return { event: occ ? localOccurrenceToApiEvent(occ) : localOccurrenceToApiEvent({
    master: updated,
    originalStart: new Date(updated.startAt),
    start: new Date(updated.startAt),
    end: new Date(updated.endAt),
    exception: null,
  }) };
}

export async function deleteLocalCalendarEvent(id, { occurrenceStart } = {}) {
  const master = await loadMasterOrThrow(id);
  const repo = AppDataSource.getRepository(CalendarEventLocal);

  if (occurrenceStart && master.recurrenceFrequency) {
    const originalStart = parseDate(occurrenceStart, 'occurrenceStart');
    const exRepo = AppDataSource.getRepository(CalendarEventLocalException);
    const exceptions = await loadExceptions(master.id);
    let ex = findException(exceptions, originalStart);
    if (ex) {
      ex.isCancelled = true;
      await exRepo.save(ex);
    } else {
      await exRepo.save(
        exRepo.create({
          masterEventId: master.id,
          originalStartAt: originalStart,
          isCancelled: true,
        })
      );
    }
    return { cancelled: true, occurrenceStart: originalStart.toISOString() };
  }

  await repo.update({ id: master.id }, { deletedAt: new Date() });
  return { deleted: true };
}

export async function cancelLocalOccurrence(id, occurrenceStart) {
  return deleteLocalCalendarEvent(id, { occurrenceStart });
}

export function parseLocalEventId(apiId) {
  if (!apiId || !String(apiId).startsWith('local:')) return null;
  const rest = String(apiId).slice('local:'.length);
  const sep = rest.lastIndexOf(':');
  if (sep === -1) {
    return { masterId: rest, occurrenceStart: null };
  }
  const masterId = rest.slice(0, sep);
  const ts = Number(rest.slice(sep + 1));
  if (!Number.isFinite(ts)) {
    return { masterId: rest, occurrenceStart: null };
  }
  return { masterId, occurrenceStart: new Date(ts).toISOString() };
}
