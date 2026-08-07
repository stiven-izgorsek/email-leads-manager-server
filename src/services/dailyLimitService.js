import { AppDataSource } from '../config/database.js';
import { MarketingAssignment } from '../entities/MarketingAssignment.js';
import { MarketingAssignmentLead } from '../entities/MarketingAssignmentLead.js';
import { FollowupAssignment } from '../entities/FollowupAssignment.js';
import { FollowupAssignmentLead } from '../entities/FollowupAssignmentLead.js';

function getAssignmentDateString(input) {
  if (input) {
    const s = String(input).trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  }
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function effectiveSentForDailyLimit(sent, baseline) {
  const raw = Math.max(0, parseInt(String(sent), 10) || 0);
  const base = Math.max(0, parseInt(String(baseline), 10) || 0);
  return Math.max(0, raw - base);
}

export function resolveDailyLimitFromEmail(email, defaultCount = 10) {
  const fallback = Math.max(1, Math.min(500, parseInt(String(defaultCount), 10) || 10));
  const daily = email?.marketingDailyLimit;
  if (daily != null && Number.isFinite(Number(daily)) && Number(daily) > 0) {
    return Math.max(1, Math.min(500, parseInt(String(daily), 10)));
  }
  return fallback;
}

async function getAssignmentLeadStats(repo, assignmentIds) {
  if (!assignmentIds.length) return new Map();
  const rows = await repo
    .createQueryBuilder('lead')
    .select('lead.assignmentId', 'assignmentId')
    .addSelect('lead.sendStatus', 'sendStatus')
    .addSelect('COUNT(*)', 'cnt')
    .where('lead.assignmentId IN (:...assignmentIds)', { assignmentIds })
    .groupBy('lead.assignmentId')
    .addGroupBy('lead.sendStatus')
    .getRawMany();

  const map = new Map();
  for (const id of assignmentIds) {
    map.set(id, { assigned: 0, pending: 0, sent: 0, failed: 0 });
  }
  for (const r of rows) {
    const entry = map.get(r.assignmentId) || { assigned: 0, pending: 0, sent: 0, failed: 0 };
    const cnt = parseInt(String(r.cnt), 10) || 0;
    entry.assigned += cnt;
    if (r.sendStatus === 'pending') entry.pending += cnt;
    else if (r.sendStatus === 'sent') entry.sent += cnt;
    else if (r.sendStatus === 'failed') entry.failed += cnt;
    map.set(r.assignmentId, entry);
  }
  return map;
}

/**
 * Cold outreach (marketing) daily limit — independent of follow-up counts.
 */
export async function getMarketingDailyLimitState(email, assignmentDate, defaultCount = 10) {
  const date = getAssignmentDateString(assignmentDate);
  const limit = resolveDailyLimitFromEmail(email, defaultCount);
  const assignmentRepo = AppDataSource.getRepository(MarketingAssignment);
  const assignment = await assignmentRepo.findOne({ where: { emailId: email.id, assignmentDate: date } });

  if (!assignment) {
    return {
      channel: 'marketing',
      limit,
      pending: 0,
      sent: 0,
      baseline: 0,
      effectiveSent: 0,
      remaining: limit,
    };
  }

  const statsMap = await getAssignmentLeadStats(
    AppDataSource.getRepository(MarketingAssignmentLead),
    [assignment.id]
  );
  const counts = statsMap.get(assignment.id) || { pending: 0, sent: 0 };
  const baseline = assignment.dailyLimitSentBaseline || 0;
  const effectiveSent = effectiveSentForDailyLimit(counts.sent, baseline);
  const pending = counts.pending || 0;

  return {
    channel: 'marketing',
    limit,
    pending,
    sent: counts.sent || 0,
    baseline,
    effectiveSent,
    remaining: Math.max(0, limit - pending - effectiveSent),
  };
}

/**
 * Follow-up daily limit — independent of cold outreach counts.
 */
export async function getFollowupDailyLimitState(email, assignmentDate, defaultCount = 10) {
  const date = getAssignmentDateString(assignmentDate);
  const limit = resolveDailyLimitFromEmail(email, defaultCount);
  const assignmentRepo = AppDataSource.getRepository(FollowupAssignment);
  const assignment = await assignmentRepo.findOne({ where: { emailId: email.id, assignmentDate: date } });

  if (!assignment) {
    return {
      channel: 'followup',
      limit,
      pending: 0,
      sent: 0,
      baseline: 0,
      effectiveSent: 0,
      remaining: limit,
    };
  }

  const statsMap = await getAssignmentLeadStats(
    AppDataSource.getRepository(FollowupAssignmentLead),
    [assignment.id]
  );
  const counts = statsMap.get(assignment.id) || { pending: 0, sent: 0 };
  const baseline = assignment.dailyLimitSentBaseline || 0;
  const effectiveSent = effectiveSentForDailyLimit(counts.sent, baseline);
  const pending = counts.pending || 0;

  return {
    channel: 'followup',
    limit,
    pending,
    sent: counts.sent || 0,
    baseline,
    effectiveSent,
    remaining: Math.max(0, limit - pending - effectiveSent),
  };
}

export async function marketingCanSendAnother(email, assignmentDate, defaultCount = 10) {
  const state = await getMarketingDailyLimitState(email, assignmentDate, defaultCount);
  return state.effectiveSent < state.limit;
}

export async function followupCanSendAnother(email, assignmentDate, defaultCount = 10) {
  const state = await getFollowupDailyLimitState(email, assignmentDate, defaultCount);
  return state.effectiveSent < state.limit;
}
