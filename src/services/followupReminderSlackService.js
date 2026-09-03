const WEBHOOK_URL = String(process.env.SLACK_FOLLOWUP_REMINDER_WEBHOOK || '').trim();
const CHANNEL = String(process.env.SLACK_FOLLOWUP_REMINDER_CHANNEL || '#followup-reminder').trim();

const STATUS_LABELS = {
  first_connected: 'First connected',
  no_response: 'No response',
  in_discussion: 'In discussion',
  first_call_scheduled: '1st call scheduled',
  second_call_scheduled: '2nd call scheduled',
  proposal_sent: 'Proposal sent',
  nda_signed: 'NDA signed',
  contract_signed: 'Contract signed',
  stay_connect: 'Stay connect',
  on_hold: 'On hold',
  failed: 'Failed',
};

function fmtDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function fmtRating(rating) {
  if (!rating) return '—';
  return '⭐'.repeat(Math.round(rating));
}

function fmtStatuses(statuses) {
  if (!statuses?.length) return '—';
  return statuses.map((s) => STATUS_LABELS[s] || s).join(', ');
}

/**
 * Post a follow-up reminder for a single CRM client to #followup-reminder.
 * @param {object} client - serialized CrmClient row
 */
export async function postFollowupReminderToSlack(client) {
  if (!WEBHOOK_URL) {
    const err = new Error(
      'Slack follow-up reminder webhook is not configured (set SLACK_FOLLOWUP_REMINDER_WEBHOOK)'
    );
    err.status = 400;
    throw err;
  }

  const name = [client.firstName, client.lastName].filter(Boolean).join(' ') || client.email || '(unknown)';
  const company = client.companyName ? ` · ${client.companyName}` : '';

  const text =
    `*📅 Follow-up reminder*\n` +
    `*Client:* ${name}${company}\n` +
    `*Client email:* ${client.email || '—'}\n` +
    `*Account:* ${client.sentByAccount || '—'}\n` +
    `*Follow-up date:* ${fmtDate(client.followUpAt)}\n` +
    `*Status:* ${fmtStatuses(client.statuses)}\n` +
    `*Rating:* ${fmtRating(client.rating)}`;

  const response = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: CHANNEL, text }),
  });

  if (!response.ok) {
    const respText = await response.text().catch(() => '');
    throw new Error(`Slack webhook failed (${response.status}): ${respText || response.statusText}`);
  }
}
