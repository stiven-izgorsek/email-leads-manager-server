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
    params.set('event_type', 'default');
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

function parseTimespanFields(ts) {
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
  return null;
}

function parseDateString(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(d)) return null;
  const day = d.slice(0, 10);
  return {
    start: new Date(`${day}T00:00:00`),
    end: new Date(`${day}T23:59:59.999`),
    allDay: true,
  };
}

function parseDatespanFields(sd, ed) {
  if (typeof sd !== 'string' || typeof ed !== 'string') return null;
  return {
    start: new Date(`${sd.slice(0, 10)}T00:00:00`),
    end: new Date(`${ed.slice(0, 10)}T23:59:59.999`),
    allDay: true,
  };
}

/**
 * Parse Nylas event `when` object → start/end Date and allDay flag.
 * Supports Nylas v3 flat shape (`object: "timespan"`, `start_time`, …) and legacy nested shapes.
 * @param {object | null | undefined} when
 * @returns {{ start: Date, end: Date, allDay: boolean } | null}
 */
export function parseEventWhen(when) {
  if (!when || typeof when !== 'object') return null;

  const kind = typeof when.object === 'string' ? when.object : null;

  if (kind === 'timespan' || when.start_time != null || when.start != null) {
    const parsed = parseTimespanFields(when);
    if (parsed) return parsed;
  }

  if (when.timespan && typeof when.timespan === 'object') {
    const parsed = parseTimespanFields(when.timespan);
    if (parsed) return parsed;
  }

  if (kind === 'date' || (typeof when.date === 'string' && when.date)) {
    const parsed = parseDateString(typeof when.date === 'string' ? when.date : '');
    if (parsed) return parsed;
  }

  if (when.date && typeof when.date === 'object') {
    const d = when.date.date || when.date;
    const parsed = parseDateString(typeof d === 'string' ? d : '');
    if (parsed) return parsed;
  }

  if (kind === 'datespan' || when.start_date || when.end_date) {
    const parsed = parseDatespanFields(
      when.start_date || when.start,
      when.end_date || when.end
    );
    if (parsed) return parsed;
  }

  if (when.datespan && typeof when.datespan === 'object') {
    const ds = when.datespan;
    const parsed = parseDatespanFields(ds.start_date || ds.start, ds.end_date || ds.end);
    if (parsed) return parsed;
  }

  return null;
}

/** Skip all-day items (public holidays, birthdays, etc.) — keep timed meetings. */
export function shouldIncludeCalendarEvent(whenParsed) {
  return Boolean(whenParsed && !whenParsed.allDay);
}

const KNOWN_MEETING_PATTERNS = [
  { provider: 'google_meet', regex: /https?:\/\/meet\.google\.com\/[a-z0-9-]+/i },
  { provider: 'zoom', regex: /https?:\/\/(?:[a-z0-9-]+\.)?zoom\.us\/(?:j|my|w|s|wc)\/[^\s"'<>]+/i },
  { provider: 'teams', regex: /https?:\/\/teams\.(?:live|microsoft)\.com\/(?:l|meet)\/[^\s"'<>]+/i },
  { provider: 'webex', regex: /https?:\/\/(?:[a-z0-9-]+\.)?webex\.com\/(?:meet|join)\/[^\s"'<>]+/i },
  { provider: 'whereby', regex: /https?:\/\/(?:[a-z0-9-]+\.)?whereby\.com\/[^\s"'<>]+/i },
  { provider: 'jitsi', regex: /https?:\/\/(?:[a-z0-9-]+\.)?meet\.jit\.si\/[^\s"'<>]+/i },
  { provider: 'gotomeeting', regex: /https?:\/\/(?:[a-z0-9-]+\.)?gotomeeting\.com\/[^\s"'<>]+/i },
  { provider: 'bluejeans', regex: /https?:\/\/(?:[a-z0-9-]+\.)?bluejeans\.com\/[^\s"'<>]+/i },
];

function detectProviderFromUrl(url) {
  if (!url) return null;
  for (const { provider, regex } of KNOWN_MEETING_PATTERNS) {
    if (regex.test(url)) return provider;
  }
  return null;
}

function scanTextForMeetingUrl(text) {
  if (!text || typeof text !== 'string') return null;
  for (const { provider, regex } of KNOWN_MEETING_PATTERNS) {
    const m = text.match(regex);
    if (m && m[0]) return { url: m[0], provider };
  }
  return null;
}

/**
 * Extract the meeting URL + provider from a Nylas event.
 * Prefers structured `conferencing` data, then falls back to description/location.
 * @returns {{ url: string | null, provider: string | null }}
 */
export function extractMeetingDetails(ev) {
  const conferencing = ev?.conferencing || ev?.conference_data || null;
  const conferencingProvider = conferencing?.provider
    ? String(conferencing.provider).toLowerCase().replace(/[^a-z0-9_]/g, '_')
    : null;

  const directCandidates = [
    conferencing?.details?.url,
    conferencing?.details?.join_url,
    conferencing?.details?.meeting_url,
    conferencing?.url,
    conferencing?.join_url,
    conferencing?.meeting_url,
    ev?.conference_url,
    ev?.meeting_url,
    ev?.hangout_link,
  ];

  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) {
      return {
        url: candidate.trim(),
        provider: conferencingProvider || detectProviderFromUrl(candidate),
      };
    }
  }

  const textBlobs = [ev?.description, ev?.location, ev?.html_link];
  for (const blob of textBlobs) {
    const found = scanTextForMeetingUrl(blob);
    if (found) {
      return { url: found.url, provider: conferencingProvider || found.provider };
    }
  }

  return { url: null, provider: conferencingProvider };
}
