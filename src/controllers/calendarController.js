import {
  listCalendarEventsFromDb,
  parseUnixRange,
  syncCalendarEventsFromNylas,
  softDeleteNylasCalendarEvent,
  getEnrichedCalendarEventById,
} from '../services/calendarSyncService.js';
import {
  createLocalCalendarEvent,
  updateLocalCalendarEvent,
  deleteLocalCalendarEvent,
  cancelLocalOccurrence,
  parseLocalEventId,
} from '../services/localCalendarService.js';
import { notifyMeetingToSlackNow } from '../services/meetingReminderService.js';

function validateRange(rawStart, rawEnd, res) {
  if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
    res.status(400).json({
      error:
        'Provide start and end as Unix seconds (?start=&end=) or ISO (?startDate=&endDate=)',
    });
    return false;
  }
  if (rawEnd < rawStart) {
    res.status(400).json({ error: 'end must be >= start' });
    return false;
  }
  const maxSpanSec = 366 * 24 * 60 * 60;
  if (rawEnd - rawStart > maxSpanSec) {
    res.status(400).json({ error: 'Date range cannot exceed ~366 days' });
    return false;
  }
  return true;
}

function extractEmailIds(source) {
  const single = (source?.emailId || '').toString().trim();
  const multi = source?.emailIds;
  if (Array.isArray(multi)) return { emailIds: multi, emailId: single || undefined };
  if (typeof multi === 'string' && multi.trim()) {
    return { emailIds: multi, emailId: single || undefined };
  }
  return { emailIds: undefined, emailId: single || undefined };
}

/** GET — read events from database only (no Nylas). */
export async function listCalendarEvents(req, res) {
  try {
    const { startSec: rawStart, endSec: rawEnd } = parseUnixRange(req.query);
    if (!validateRange(rawStart, rawEnd, res)) return;

    const { emailId, emailIds } = extractEmailIds(req.query);
    const payload = await listCalendarEventsFromDb({
      startSec: rawStart,
      endSec: rawEnd,
      emailId,
      emailIds,
    });

    return res.json({
      success: true,
      ...payload,
    });
  } catch (error) {
    console.error('listCalendarEvents error:', error);
    return res.status(500).json({ error: error.message || 'Failed to load calendar events' });
  }
}

/** POST — refetch from Nylas, save to DB, return events for the range. */
export async function syncCalendarEvents(req, res) {
  try {
    const q = { ...req.query, ...(req.body || {}) };
    const { startSec: rawStart, endSec: rawEnd } = parseUnixRange(q);
    if (!validateRange(rawStart, rawEnd, res)) return;

    const { emailId, emailIds } = extractEmailIds(q);

    const syncResult = await syncCalendarEventsFromNylas({
      startSec: rawStart,
      endSec: rawEnd,
      emailId,
      emailIds,
    });

    const payload = await listCalendarEventsFromDb({
      startSec: rawStart,
      endSec: rawEnd,
      emailId,
      emailIds,
    });

    return res.json({
      success: true,
      ...payload,
      fromCache: false,
      lastSyncedAt: syncResult.syncedAt,
      sync: {
        upserted: syncResult.upserted,
        removed: syncResult.removed,
        mailboxes: syncResult.mailboxes,
      },
      errors: syncResult.errors,
    });
  } catch (error) {
    console.error('syncCalendarEvents error:', error);
    return res.status(500).json({ error: error.message || 'Failed to sync calendar events' });
  }
}

/** POST — create a manual local calendar event. */
export async function createLocalEventHandler(req, res) {
  try {
    const result = await createLocalCalendarEvent(req.body || {});
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    console.error('createLocalEvent error:', error);
    const msg = error.message || 'Failed to create event';
    const status = /required|Invalid|must be|not found/i.test(msg) ? 400 : 500;
    return res.status(status).json({ error: msg });
  }
}

/** PATCH — update a local event (series or single occurrence). */
export async function updateLocalEventHandler(req, res) {
  try {
    const { id } = req.params;
    const parsed = parseLocalEventId(id) || { masterId: id, occurrenceStart: null };
    const body = { ...(req.body || {}) };
    if (!body.occurrenceStart && parsed.occurrenceStart) {
      body.occurrenceStart = parsed.occurrenceStart;
    }
    const result = await updateLocalCalendarEvent(parsed.masterId, body);
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('updateLocalEvent error:', error);
    const msg = error.message || 'Failed to update event';
    const status = /required|Invalid|must be|not found|only valid/i.test(msg) ? 400 : 500;
    return res.status(status).json({ error: msg });
  }
}

/** DELETE — soft-delete a local series or cancel one occurrence. */
export async function deleteLocalEventHandler(req, res) {
  try {
    const { id } = req.params;
    const parsed = parseLocalEventId(id) || { masterId: id, occurrenceStart: null };
    const occurrenceStart =
      req.query?.occurrenceStart ||
      req.body?.occurrenceStart ||
      parsed.occurrenceStart ||
      null;
    const result = await deleteLocalCalendarEvent(parsed.masterId, { occurrenceStart });
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('deleteLocalEvent error:', error);
    const msg = error.message || 'Failed to delete event';
    const status = /Invalid|not found/i.test(msg) ? 400 : 500;
    return res.status(status).json({ error: msg });
  }
}

/**
 * DELETE — platform soft-delete for any calendar event (local or synced/Nylas).
 * Does not cancel the event in Google/Nylas.
 */
export async function deleteCalendarEventHandler(req, res) {
  try {
    const { id } = req.params;
    const rawId = decodeURIComponent(String(id || ''));

    if (String(rawId).startsWith('local:') || parseLocalEventId(rawId)) {
      const parsed = parseLocalEventId(rawId) || { masterId: rawId, occurrenceStart: null };
      const occurrenceStart =
        req.query?.occurrenceStart ||
        req.body?.occurrenceStart ||
        parsed.occurrenceStart ||
        null;
      const result = await deleteLocalCalendarEvent(parsed.masterId, { occurrenceStart });
      return res.json({ success: true, source: 'local', ...result });
    }

    const result = await softDeleteNylasCalendarEvent(rawId);
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('deleteCalendarEvent error:', error);
    const msg = error.message || 'Failed to delete event';
    const status = /Invalid|not found/i.test(msg) ? 400 : 500;
    return res.status(status).json({ error: msg });
  }
}

/** POST — cancel a single occurrence of a recurring local event. */
export async function cancelLocalOccurrenceHandler(req, res) {
  try {
    const { id } = req.params;
    const parsed = parseLocalEventId(id) || { masterId: id, occurrenceStart: null };
    const occurrenceStart =
      req.body?.occurrenceStart || parsed.occurrenceStart || req.query?.occurrenceStart;
    if (!occurrenceStart) {
      return res.status(400).json({ error: 'occurrenceStart is required' });
    }
    const result = await cancelLocalOccurrence(parsed.masterId, occurrenceStart);
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('cancelLocalOccurrence error:', error);
    const msg = error.message || 'Failed to cancel occurrence';
    const status = /Invalid|not found|required/i.test(msg) ? 400 : 500;
    return res.status(status).json({ error: msg });
  }
}

/** POST — immediately send meeting details to Slack (no reminder wait). */
export async function notifyCalendarEventSlackHandler(req, res) {
  try {
    const rawId = decodeURIComponent(String(req.params.id || ''));
    if (!rawId || String(rawId).startsWith('local:')) {
      return res.status(400).json({ error: 'Slack notify is only supported for synced calendar events' });
    }
    const event = await getEnrichedCalendarEventById(rawId);
    const availableRaw = req.body?.available;
    const available =
      availableRaw === undefined || availableRaw === null
        ? true
        : availableRaw === true || availableRaw === 'true' || availableRaw === 1 || availableRaw === '1';
    await notifyMeetingToSlackNow(event, { available });
    return res.json({ success: true, notified: true, eventId: event.id, available });
  } catch (error) {
    console.error('notifyCalendarEventSlack error:', error);
    const msg = error.message || 'Failed to notify Slack';
    const status = /not found|Invalid|not configured/i.test(msg) ? 400 : 500;
    return res.status(status).json({ error: msg });
  }
}
