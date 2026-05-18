import { NYLAS_LIST_PAGE_LIMIT, sleep } from '../utils/nylasRateLimit.js';

const configuredNylasRegion = (process.env.NYLAS_REGION || '').toLowerCase();

export function getNylasBaseUrls() {
  if (configuredNylasRegion === 'us') return ['https://api.us.nylas.com'];
  if (configuredNylasRegion === 'eu') return ['https://api.eu.nylas.com'];
  return ['https://api.eu.nylas.com', 'https://api.us.nylas.com'];
}

function formatFetchError(err) {
  if (!err) return 'Unknown error';
  const parts = [err.message || String(err)];
  if (err.cause) {
    parts.push(`cause: ${err.cause.message || err.cause}`);
  }
  return parts.join(' | ');
}

/**
 * List all events in the given window for a grant (primary calendar), with pagination.
 * @param {string} grantId
 * @param {string} nylasKey
 * @param {number} startSec Unix seconds (inclusive)
 * @param {number} endSec Unix seconds (inclusive)
 * @returns {Promise<{ events: object[], error: Error | null }>}
 */
export async function fetchPrimaryCalendarEvents(grantId, nylasKey, startSec, endSec) {
  const baseUrls = getNylasBaseUrls();
  const all = [];
  let lastError = null;
  let pageToken = null;

  for (;;) {
    const params = new URLSearchParams();
    params.set('calendar_id', 'primary');
    params.set('start', String(startSec));
    params.set('end', String(endSec));
    params.set('limit', String(NYLAS_LIST_PAGE_LIMIT));
    if (pageToken) {
      params.set('page_token', pageToken);
    }

    const path = `/v3/grants/${encodeURIComponent(grantId)}/events?${params.toString()}`;

    let payload = null;
    for (const baseUrl of baseUrls) {
      const url = `${baseUrl}${path}`;
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${nylasKey}`,
            Accept: 'application/json',
          },
        });
        if (response.ok) {
          payload = await response.json();
          lastError = null;
          break;
        }
        const text = await response.text().catch(() => '');
        lastError = new Error(
          `Nylas events failed (${response.status}) on ${baseUrl}: ${text || response.statusText}`
        );
        if (response.status === 401 && configuredNylasRegion) {
          return { events: [], error: lastError };
        }
      } catch (err) {
        lastError = new Error(`Nylas events fetch on ${baseUrl}: ${formatFetchError(err)}`);
        if (configuredNylasRegion) {
          return { events: [], error: lastError };
        }
      }
    }

    if (!payload) {
      return { events: all.length ? all : [], error: lastError || new Error('Nylas events request failed') };
    }

    const chunk = Array.isArray(payload?.data) ? payload.data : [];
    all.push(...chunk);
    pageToken = payload?.next_cursor || null;
    if (!pageToken) break;
    await sleep(120);
  }

  return { events: all, error: null };
}

/**
 * Parse Nylas event `when` object → start/end Date and allDay flag.
 * @param {object | null | undefined} when
 * @returns {{ start: Date, end: Date, allDay: boolean } | null}
 */
export function parseEventWhen(when) {
  if (!when || typeof when !== 'object') return null;

  if (when.timespan && typeof when.timespan === 'object') {
    const ts = when.timespan;
    const s =
      ts.start_time != null
        ? Number(ts.start_time)
        : ts.start != null
          ? Number(ts.start)
          : null;
    const e =
      ts.end_time != null ? Number(ts.end_time) : ts.end != null ? Number(ts.end) : null;
    if (s != null && !Number.isNaN(s) && e != null && !Number.isNaN(e)) {
      return {
        start: new Date(s * 1000),
        end: new Date(e * 1000),
        allDay: false,
      };
    }
  }

  if (when.date && typeof when.date === 'object') {
    const d = when.date.date || when.date;
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) {
      const day = d.slice(0, 10);
      const start = new Date(`${day}T00:00:00`);
      const end = new Date(`${day}T23:59:59.999`);
      return { start, end, allDay: true };
    }
  }

  if (when.datespan && typeof when.datespan === 'object') {
    const ds = when.datespan;
    const sd = ds.start_date || ds.start;
    const ed = ds.end_date || ds.end;
    if (typeof sd === 'string' && typeof ed === 'string') {
      const start = new Date(`${sd.slice(0, 10)}T00:00:00`);
      const end = new Date(`${ed.slice(0, 10)}T23:59:59.999`);
      return { start, end, allDay: true };
    }
  }

  return null;
}
