import { AppDataSource } from '../config/database.js';
import { CalendarSlackNotification } from '../entities/CalendarSlackNotification.js';
import { listCalendarEventsFromDb } from './calendarSyncService.js';

function getMeetingsWebhookUrl() {
  return (
    String(process.env.SLACK_MEETINGS_WEBHOOK || '').trim() ||
    String(process.env.SLACK_INCOMING_MESSAGES_WEBHOOK || '').trim() ||
    ''
  );
}

function getReminderLeadMinutes() {
  const n = parseInt(process.env.MEETING_REMINDER_MINUTES || '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 10;
}

function getReminderPollMs() {
  const n = parseInt(process.env.MEETING_REMINDER_POLL_MS || '', 10);
  return Math.max(15_000, Number.isFinite(n) && n > 0 ? n : 60_000);
}

function getSlackMeetingsChannel() {
  return (
    String(process.env.SLACK_MEETINGS_CHANNEL || '#meeting-notification').trim() ||
    '#meeting-notification'
  );
}

function formatWhen(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return String(iso);
  }
}

function formatDuration(startIso, endIso) {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const mins = Math.round((end - start) / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function formatParticipants(ev) {
  const parts = Array.isArray(ev?.participants) ? ev.participants : [];
  if (!parts.length) return null;
  return parts
    .map((p) => {
      const name = String(p?.name || '').trim();
      const email = String(p?.email || '').trim();
      if (name && email) return `${name} <${email}>`;
      return name || email || null;
    })
    .filter(Boolean)
    .slice(0, 12)
    .join(', ');
}

function trimDescription(text, maxLen = 500) {
  const s = String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return s.length <= maxLen ? s : `${s.slice(0, maxLen)}…`;
}

function minutesUntil(startIso) {
  const start = new Date(startIso).getTime();
  if (!Number.isFinite(start)) return null;
  return Math.max(0, Math.round((start - Date.now()) / 60000));
}

function trimField(text, maxLen = 800) {
  const s = String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return s.length <= maxLen ? s : `${s.slice(0, maxLen)}…`;
}

function contactDisplayName(contact) {
  const crm = contact?.crmClient;
  if (crm) {
    const n = [crm.firstName, crm.lastName].filter(Boolean).join(' ').trim();
    if (n) return n;
  }
  const lead = contact?.lead;
  if (lead) {
    const n = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim();
    if (n) return n;
  }
  return contact?.name || contact?.email || null;
}

function formatContactBlock(contact) {
  if (!contact) return [];
  const lines = [];
  const name = contactDisplayName(contact);
  const email = contact.email || contact.crmClient?.email || contact.lead?.email;
  lines.push(`*Contact:* ${name && email ? `${name} <${email}>` : name || email || '—'}`);

  const crm = contact.crmClient;
  const lead = contact.lead || crm?.lead || null;
  const account = contact.account || crm?.account || null;

  if (crm) {
    const clientBits = [
      crm.jobTitle,
      crm.country,
      Array.isArray(crm.statuses) && crm.statuses.length
        ? `status: ${crm.statuses.join(', ')}`
        : crm.status
          ? `status: ${crm.status}`
          : null,
      crm.linkedin ? `linkedin: ${crm.linkedin}` : null,
      crm.sentByAccount ? `sent by: ${crm.sentByAccount}` : null,
    ].filter(Boolean);
    if (clientBits.length) lines.push(`*Client data:* ${clientBits.join(' · ')}`);

    const companyBits = [crm.companyName].filter(Boolean);
    if (companyBits.length) lines.push(`*Company:* ${companyBits.join(' · ')}`);

    const note = trimField(crm.note, 600);
    if (note) lines.push(`*Note:* ${note}`);

    const chat = trimField(crm.chatHistory, 600);
    if (chat) lines.push(`*Chat history:* ${chat}`);
  }

  if (lead) {
    const companyBits = [
      lead.companyName,
      lead.companyUrl,
      lead.companyLocation || lead.location,
      lead.jobTitle,
    ].filter(Boolean);
    if (companyBits.length) {
      lines.push(`*Company / lead data:* ${companyBits.join(' · ')}`);
    }
    if (!crm) {
      const leadBits = [
        [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || null,
        lead.email,
        lead.linkedin ? `linkedin: ${lead.linkedin}` : null,
        lead.status ? `status: ${lead.status}` : null,
      ].filter(Boolean);
      if (leadBits.length) lines.push(`*Lead data:* ${leadBits.join(' · ')}`);
      const leadNote = trimField(lead.note, 600);
      if (leadNote) lines.push(`*Note:* ${leadNote}`);
    }
  }

  if (account) {
    const accountBits = [
      account.name || [account.firstName, account.lastName].filter(Boolean).join(' ').trim() || null,
      account.mailboxEmail,
      account.country,
      account.linkedin ? `linkedin: ${account.linkedin}` : null,
    ].filter(Boolean);
    if (accountBits.length) lines.push(`*Account:* ${accountBits.join(' · ')}`);
    if (account.cv) lines.push(`*Account CV:* ${account.cv}`);
  }

  return lines;
}

function collectContactsForSlack(ev) {
  const list = Array.isArray(ev?.linkedContacts) ? ev.linkedContacts : [];
  if (list.length) return list.slice(0, 5);

  // Fallback for older payloads
  const out = [];
  const seen = new Set();
  const push = (contact) => {
    const em = contact?.email ? String(contact.email).trim().toLowerCase() : '';
    if (!em || seen.has(em)) return;
    if (!contact.crmClient && !contact.lead) return;
    seen.add(em);
    out.push(contact);
  };
  if (ev?.organizer) {
    push({
      email: ev.organizer.email,
      name: ev.organizer.name,
      crmClient: ev.organizer.crmClient || null,
      lead: ev.organizer.lead || null,
      account: ev.organizer.account || null,
    });
  }
  for (const c of ev?.linkedClients || []) {
    push({
      email: c.email,
      name: null,
      crmClient: c,
      lead: c.lead || null,
      account: c.account || null,
    });
  }
  return out.slice(0, 5);
}

export function buildMeetingSlackText(ev, { leadMinutes, manual = false, available } = {}) {
  const mins = minutesUntil(ev.start);
  const lead = leadMinutes ?? getReminderLeadMinutes();
  const whenLabel = manual
    ? `*Meeting notification (manual)*`
    : mins != null && mins <= lead + 1
      ? `*Meeting in ~${mins} minute${mins === 1 ? '' : 's'}*`
      : `*Upcoming meeting*`;

  const lines = [
    whenLabel,
    `*Title:* ${ev.title || '(no title)'}`,
    `*When:* ${formatWhen(ev.start)}${ev.end ? ` → ${formatWhen(ev.end)}` : ''}`,
  ];

  if (available === true) {
    lines.push(`*Availability:* ✅ Available to join`);
  } else if (available === false) {
    lines.push(`*Availability:* ❌ Not available to join`);
  }

  const duration = formatDuration(ev.start, ev.end);
  if (duration) lines.push(`*Duration:* ${duration}`);
  if (ev.mailboxEmail) lines.push(`*Mailbox:* ${ev.mailboxEmail}`);
  if (ev.location) lines.push(`*Location:* ${ev.location}`);
  if (ev.meetingUrl) {
    const provider = ev.meetingProvider ? ` (${ev.meetingProvider})` : '';
    lines.push(`*Meeting link:* ${ev.meetingUrl}${provider}`);
  } else if (ev.htmlLink) {
    lines.push(`*Calendar link:* ${ev.htmlLink}`);
  }

  const organizer = ev.organizer;
  if (organizer?.email || organizer?.name) {
    const name = organizer.name || '';
    const email = organizer.email || '';
    lines.push(`*Organizer:* ${name && email ? `${name} <${email}>` : name || email}`);
  }

  const participants = formatParticipants(ev);
  if (participants) lines.push(`*Participants:* ${participants}`);

  const desc = trimDescription(ev.description);
  if (desc) lines.push(`*Description:*\n${desc}`);

  const contacts = collectContactsForSlack(ev);
  for (const contact of contacts) {
    const block = formatContactBlock(contact);
    if (block.length) {
      lines.push('---');
      lines.push(...block);
    }
  }

  // Mailbox account fallback when contacts have no account
  if (ev.mailboxAccount?.cv || ev.mailboxAccount?.name) {
    const hasAccount = contacts.some((c) => c.account?.cv || c.account?.name);
    if (!hasAccount) {
      lines.push('---');
      const bits = [
        ev.mailboxAccount.name,
        ev.mailboxAccount.mailboxEmail,
        ev.mailboxAccount.country,
      ].filter(Boolean);
      if (bits.length) lines.push(`*Account:* ${bits.join(' · ')}`);
      if (ev.mailboxAccount.cv) lines.push(`*Account CV:* ${ev.mailboxAccount.cv}`);
    }
  }

  return lines.join('\n');
}

async function sendMeetingToSlack(ev, { manual = false, available } = {}) {
  const webhookUrl = getMeetingsWebhookUrl();
  if (!webhookUrl) {
    throw new Error('Slack meetings webhook is not configured');
  }
  const text = buildMeetingSlackText(ev, { manual, available });
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: getSlackMeetingsChannel(),
      text,
    }),
  });
  if (!response.ok) {
    const respText = await response.text().catch(() => '');
    throw new Error(`Slack webhook failed (${response.status}): ${respText || response.statusText}`);
  }
}

/**
 * Immediately notify Slack for a meeting (manual button — does not wait for reminder window).
 */
export async function notifyMeetingToSlackNow(ev, { available = true } = {}) {
  if (!ev) throw new Error('Event is required');
  await sendMeetingToSlack(ev, { manual: true, available: available !== false });
  return { notified: true };
}

/**
 * Find meetings starting within the next MEETING_REMINDER_MINUTES and notify Slack once each.
 */
export async function runMeetingReminderTick() {
  const webhookUrl = getMeetingsWebhookUrl();
  if (!webhookUrl) {
    return { skipped: true, reason: 'no_webhook', notified: 0 };
  }

  const leadMinutes = getReminderLeadMinutes();
  const now = Date.now();
  const windowStartSec = Math.floor(now / 1000);
  const windowEndSec = Math.floor((now + leadMinutes * 60_000) / 1000);

  const { events } = await listCalendarEventsFromDb({
    startSec: windowStartSec,
    endSec: windowEndSec + 60,
  });

  const upcoming = (events || []).filter((ev) => {
    if (!ev?.start || ev.allDay) return false;
    if (String(ev.status || '').toLowerCase() === 'cancelled') return false;
    const startMs = new Date(ev.start).getTime();
    if (!Number.isFinite(startMs)) return false;
    // Notify once the meeting is within the lead window (e.g. ≤ 10 minutes away).
    return startMs > now && startMs <= now + leadMinutes * 60_000;
  });

  if (!upcoming.length) {
    return { skipped: false, notified: 0, checked: 0 };
  }

  const repo = AppDataSource.getRepository(CalendarSlackNotification);
  let notified = 0;

  for (const ev of upcoming) {
    const eventKey = String(ev.id || '').trim();
    const occurrenceStart = new Date(ev.start);
    if (!eventKey || Number.isNaN(occurrenceStart.getTime())) continue;

    const existing = await repo.findOne({
      where: { eventKey, occurrenceStart },
    });
    if (existing) continue;

    try {
      await sendMeetingToSlack(ev);
      await repo.save(
        repo.create({
          eventKey,
          occurrenceStart,
          title: ev.title || null,
          mailboxEmail: ev.mailboxEmail || null,
        })
      );
      notified += 1;
      console.log(
        `[meeting-reminder] Slack notified: "${ev.title || '(no title)'}" at ${ev.start} (${ev.mailboxEmail || 'no mailbox'})`
      );
    } catch (error) {
      // Unique race: another tick inserted first — treat as already notified.
      if (error?.code === '23505') continue;
      console.error(
        `[meeting-reminder] Failed for ${eventKey}:`,
        error?.message || error
      );
    }
  }

  return { skipped: false, notified, checked: upcoming.length };
}

let timer = null;
let running = false;

async function tick() {
  if (running) {
    console.log('[meeting-reminder] Skipping tick — previous still running');
    return;
  }
  running = true;
  try {
    await runMeetingReminderTick();
  } catch (err) {
    console.error('[meeting-reminder] Tick failed:', err);
  } finally {
    running = false;
  }
}

export function startMeetingReminderJob({ initialDelayMs = 0 } = {}) {
  if (timer) return;
  if (!getMeetingsWebhookUrl()) {
    console.log(
      '[meeting-reminder] Disabled — set SLACK_MEETINGS_WEBHOOK (or SLACK_INCOMING_MESSAGES_WEBHOOK)'
    );
    return;
  }
  const pollMs = getReminderPollMs();
  const lead = getReminderLeadMinutes();
  const kickoff = () => {
    console.log(
      `[meeting-reminder] Job every ${Math.round(pollMs / 1000)}s — Slack ~${lead} min before each meeting → ${getSlackMeetingsChannel()}`
    );
    void tick();
    timer = setInterval(() => void tick(), pollMs);
  };
  if (initialDelayMs > 0) {
    console.log(
      `[meeting-reminder] First tick in ${Math.round(initialDelayMs / 1000)}s (staggered startup)`
    );
    setTimeout(kickoff, initialDelayMs);
  } else {
    kickoff();
  }
}
