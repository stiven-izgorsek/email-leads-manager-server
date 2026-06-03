import {
  listCalendarEventsFromDb,
  parseUnixRange,
  syncCalendarEventsFromNylas,
} from '../services/calendarSyncService.js';

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
