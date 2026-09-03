import { AppDataSource } from '../config/database.js';

const NON_REPLY_TYPES = [
  'ooo',
  'ignored_sender',
  'hide_sender',
  'blocked',
  'delivery_failed',
  'no_address',
];

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatShortDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatWeekLabel(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatMonthLabel(date) {
  return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function mapRowsToCounts(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const key = String(row.bucket || row.bucket_key || '').slice(0, 10);
    if (!key) continue;
    map.set(key, Number(row.count || 0));
  }
  return map;
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

function buildTotals(series) {
  return {
    emailsSent: sum(series.emailsSent),
    replies: sum(series.replies),
    clientsCreated: sum(series.clientsCreated),
    meetings: sum(series.meetings),
  };
}

function buildPieFromTotals(totals) {
  return [
    { name: 'Emails Sent', value: totals.emailsSent, color: '#2563eb' },
    { name: 'Replies', value: totals.replies, color: '#16a34a' },
    { name: 'Clients Created', value: totals.clientsCreated, color: '#9333ea' },
    { name: 'Meetings', value: totals.meetings, color: '#ea580c' },
  ].filter((item) => item.value > 0);
}

async function queryEmailsSentGrouped(truncUnit, rangeStart, rangeEndExclusive) {
  const rows = await AppDataSource.query(
    `
    WITH marketing AS (
      SELECT DATE_TRUNC($1, mal.sent_at)::date AS bucket
      FROM marketing_assignment_lead mal
      WHERE mal.send_status = 'sent'
        AND mal.sent_at >= $2
        AND mal.sent_at < $3
    ),
    gmail_only AS (
      SELECT DATE_TRUNC($1, client."lastSent")::date AS bucket
      FROM client
      WHERE client."deletedAt" IS NULL
        AND client."isSent" = TRUE
        AND client."lastSent" >= $2
        AND client."lastSent" < $3
        AND NOT EXISTS (
          SELECT 1
          FROM marketing_assignment_lead mal
          WHERE mal.client_id = client.id
            AND mal.send_status = 'sent'
            AND mal.sent_at >= $2
            AND mal.sent_at < $3
        )
    ),
    combined AS (
      SELECT bucket FROM marketing
      UNION ALL
      SELECT bucket FROM gmail_only
    )
    SELECT TO_CHAR(bucket, 'YYYY-MM-DD') AS bucket, COUNT(*)::int AS count
    FROM combined
    GROUP BY bucket
    ORDER BY bucket
    `,
    [truncUnit, rangeStart, rangeEndExclusive]
  );
  return mapRowsToCounts(rows);
}

async function queryRepliesGrouped(truncUnit, rangeStart, rangeEndExclusive) {
  const placeholders = NON_REPLY_TYPES.map((_, i) => `$${i + 4}`).join(', ');
  const rows = await AppDataSource.query(
    `
    SELECT TO_CHAR(DATE_TRUNC($1, COALESCE(im."receivedAt", im."createdAt"))::date, 'YYYY-MM-DD') AS bucket,
           COUNT(*)::int AS count
    FROM incoming_message im
    WHERE im."deletedAt" IS NULL
      AND COALESCE(im."receivedAt", im."createdAt") >= $2
      AND COALESCE(im."receivedAt", im."createdAt") < $3
      AND LOWER(TRIM(COALESCE(im."messageType", ''))) NOT IN (${placeholders})
    GROUP BY 1
    ORDER BY 1
    `,
    [truncUnit, rangeStart, rangeEndExclusive, ...NON_REPLY_TYPES]
  );
  return mapRowsToCounts(rows);
}

async function queryClientsCreatedGrouped(truncUnit, rangeStart, rangeEndExclusive) {
  const rows = await AppDataSource.query(
    `
    SELECT TO_CHAR(DATE_TRUNC($1, cc."createdAt")::date, 'YYYY-MM-DD') AS bucket,
           COUNT(*)::int AS count
    FROM crm_client cc
    WHERE cc."deletedAt" IS NULL
      AND cc."createdAt" >= $2
      AND cc."createdAt" < $3
    GROUP BY 1
    ORDER BY 1
    `,
    [truncUnit, rangeStart, rangeEndExclusive]
  );
  return mapRowsToCounts(rows);
}

async function queryMeetingsGrouped(truncUnit, rangeStart, rangeEndExclusive) {
  const rows = await AppDataSource.query(
    `
    SELECT TO_CHAR(DATE_TRUNC($1, ce.start_at)::date, 'YYYY-MM-DD') AS bucket,
           COUNT(*)::int AS count
    FROM calendar_event ce
    WHERE ce.deleted_at IS NULL
      AND ce.start_at >= $2
      AND ce.start_at < $3
      AND (
        ce.event_status IS NULL
        OR LOWER(TRIM(ce.event_status)) NOT IN ('cancelled', 'canceled')
      )
    GROUP BY 1
    ORDER BY 1
    `,
    [truncUnit, rangeStart, rangeEndExclusive]
  );
  return mapRowsToCounts(rows);
}

function buildDailyBuckets(days) {
  const today = startOfDay(new Date());
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const start = new Date(today);
    start.setDate(start.getDate() - i);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    buckets.push({
      key: toDateKey(start),
      label: formatShortDate(start),
      start,
      end,
    });
  }
  return buckets;
}

function buildWeeklyBuckets(weeks) {
  const today = startOfDay(new Date());
  const dayOfWeek = today.getDay();
  const daysFromMonday = (dayOfWeek + 6) % 7;
  const currentWeekStart = new Date(today);
  currentWeekStart.setDate(today.getDate() - daysFromMonday);

  const buckets = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(currentWeekStart);
    start.setDate(start.getDate() - i * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    buckets.push({
      key: toDateKey(start),
      label: formatWeekLabel(start),
      start,
      end,
    });
  }
  return buckets;
}

function buildMonthlyBuckets(months) {
  const today = startOfDay(new Date());
  const buckets = [];
  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    buckets.push({
      key: toDateKey(start),
      label: formatMonthLabel(start),
      start,
      end,
    });
  }
  return buckets;
}

function lookupCountForBucket(map, bucket) {
  return map.get(bucket.key) || 0;
}

function buildSeriesFromMaps(buckets, countMaps) {
  return {
    labels: buckets.map((b) => b.label),
    emailsSent: buckets.map((b) => lookupCountForBucket(countMaps.emailsSent, b)),
    replies: buckets.map((b) => lookupCountForBucket(countMaps.replies, b)),
    clientsCreated: buckets.map((b) => lookupCountForBucket(countMaps.clientsCreated, b)),
    meetings: buckets.map((b) => lookupCountForBucket(countMaps.meetings, b)),
  };
}

async function buildPeriodAnalytics(buckets, truncUnit) {
  if (!buckets.length) {
    const empty = { emailsSent: [], replies: [], clientsCreated: [], meetings: [] };
    return {
      labels: [],
      ...empty,
      totals: buildTotals(empty),
      pie: [],
    };
  }

  const rangeStart = buckets[0].start;
  const rangeEndExclusive = buckets[buckets.length - 1].end;

  const [emailsSent, replies, clientsCreated, meetings] = await Promise.all([
    queryEmailsSentGrouped(truncUnit, rangeStart, rangeEndExclusive),
    queryRepliesGrouped(truncUnit, rangeStart, rangeEndExclusive),
    queryClientsCreatedGrouped(truncUnit, rangeStart, rangeEndExclusive),
    queryMeetingsGrouped(truncUnit, rangeStart, rangeEndExclusive),
  ]);

  const series = buildSeriesFromMaps(buckets, { emailsSent, replies, clientsCreated, meetings });
  const totals = buildTotals(series);
  return {
    ...series,
    totals,
    pie: buildPieFromTotals(totals),
  };
}

export async function getDashboardAnalytics() {
  const dailyBuckets = buildDailyBuckets(30);
  const weeklyBuckets = buildWeeklyBuckets(12);
  const monthlyBuckets = buildMonthlyBuckets(12);

  const [daily, weekly, monthly] = await Promise.all([
    buildPeriodAnalytics(dailyBuckets, 'day'),
    buildPeriodAnalytics(weeklyBuckets, 'week'),
    buildPeriodAnalytics(monthlyBuckets, 'month'),
  ]);

  return { daily, weekly, monthly };
}
