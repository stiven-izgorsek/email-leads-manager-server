import { In } from 'typeorm';
import { AppDataSource } from '../config/database.js';
import { Email } from '../entities/Email.js';
import { Client } from '../entities/Client.js';
import { MarketingAssignment } from '../entities/MarketingAssignment.js';
import { MarketingAssignmentLead } from '../entities/MarketingAssignmentLead.js';
import {
  fetchUncontactedVerifiedLeads,
  resetLeadsFromReady,
} from './leadFetchService.js';
import {
  composeLeadOutboundEmail,
  composeLeadOutboundEmailWithAi,
} from '../controllers/templateController.js';
import { sendNylasEmail } from './nylasSendService.js';
import { sendSmtpEmail, hasAppPasswordCredentials } from './smtpSendService.js';
import { sleep } from '../utils/nylasRateLimit.js';
import { getMailboxTodayStatsByEmailId, getLocalTodayRange } from './mailboxTodayOutboundService.js';
import {
  effectiveSentForDailyLimit,
  getMarketingDailyLimitState,
  marketingCanSendAnother,
  resolveDailyLimitFromEmail,
} from './dailyLimitService.js';

const BLOCKED_EMAIL_STATUSES = new Set(['bad', 'blocked']);
/** Random wait between sends on the same mailbox: new draw each time (3–5 min by default). */
const DEFAULT_MARKETING_SEND_DELAY_MIN_MS = 3 * 60 * 1000;
const DEFAULT_MARKETING_SEND_DELAY_MAX_MS = 5 * 60 * 1000;
const DEFAULT_MARKETING_MAX_PARALLEL_MAILBOXES = 5;
const DEFAULT_STUCK_RUNNING_MS = 45 * 60 * 1000;

function marketingLog(mailbox, message, extra) {
  const ts = new Date().toISOString();
  const suffix =
    extra && typeof extra === 'object' && Object.keys(extra).length > 0
      ? ` ${JSON.stringify(extra)}`
      : '';
  console.log(`[marketing] ${ts} ${mailbox || '—'} ${message}${suffix}`);
}

function parsePositiveIntEnv(name, fallback) {
  const parsed = parseInt(process.env[name] || String(fallback), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getMarketingMaxParallelMailboxes() {
  return parsePositiveIntEnv('MARKETING_MAX_PARALLEL_MAILBOXES', DEFAULT_MARKETING_MAX_PARALLEL_MAILBOXES);
}

function getStuckRunningMaxAgeMs() {
  return parsePositiveIntEnv('MARKETING_STUCK_RUNNING_MS', DEFAULT_STUCK_RUNNING_MS);
}

/**
 * After server restart/crash, in-memory send loops are gone but DB may still have running=true.
 * Call on startup to stop the UI showing false "in progress" spinners.
 */
export async function releaseAllOrphanedMarketingRuns(reason = 'server startup') {
  const repo = AppDataSource.getRepository(MarketingAssignment);
  const rows = await repo.find({ where: { running: true } });
  if (!rows.length) return 0;

  for (const row of rows) {
    row.running = false;
    if (row.status === 'running') row.status = 'assigned';
    const note = `Send loop stopped (${reason}). Start marketing again to resume pending leads.`;
    row.lastError = row.lastError || note;
  }
  await repo.save(rows);
  marketingLog(null, 'released all orphaned running flags', { count: rows.length, reason });
  return rows.length;
}

/** Clear running=true for one assignment date (used before start-all). */
async function releaseAllRunningForAssignmentDate(assignmentDate) {
  const repo = AppDataSource.getRepository(MarketingAssignment);
  const rows = await repo.find({
    where: { assignmentDate, running: true },
  });
  if (!rows.length) return 0;
  for (const row of rows) {
    row.running = false;
    if (row.status === 'running') row.status = 'assigned';
  }
  await repo.save(rows);
  marketingLog(null, 'released running flags for date', {
    assignmentDate,
    count: rows.length,
  });
  return rows.length;
}

/** Clear running flags left behind after a crash (only if stale by updatedAt). */
async function releaseStaleRunningAssignments(assignmentDate) {
  const maxAgeMs = getStuckRunningMaxAgeMs();
  const cutoff = new Date(Date.now() - maxAgeMs);
  const repo = AppDataSource.getRepository(MarketingAssignment);
  const stale = await repo
    .createQueryBuilder('a')
    .where('a.assignmentDate = :date', { date: assignmentDate })
    .andWhere('a.running = :running', { running: true })
    .andWhere('a.updatedAt < :cutoff', { cutoff })
    .getMany();

  for (const row of stale) {
    row.running = false;
    if (row.status === 'running') row.status = 'assigned';
    await repo.save(row);
    marketingLog(null, 'released stale running flag', {
      assignmentId: row.id,
      emailId: row.emailId,
      assignmentDate,
    });
  }
  return stale.length;
}

/** Only one start-all orchestrator at a time. */
let marketingOrchestratorActive = false;

export function isMarketingOrchestratorActive() {
  return marketingOrchestratorActive;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function setAssignmentsRunning(assignmentIds, running) {
  if (!assignmentIds.length) return;
  const repo = AppDataSource.getRepository(MarketingAssignment);
  if (running) {
    await repo.update({ id: In(assignmentIds) }, { running: true, status: 'running' });
  } else {
    await repo.update({ id: In(assignmentIds) }, { running: false });
  }
}

async function waitForMailboxSendSpacing(assignmentId, mailbox) {
  const leadRepo = AppDataSource.getRepository(MarketingAssignmentLead);
  const lastSent = await leadRepo.findOne({
    where: { assignmentId, sendStatus: 'sent' },
    order: { sentAt: 'DESC' },
  });
  if (!lastSent?.sentAt) return;

  const elapsed = Date.now() - new Date(lastSent.sentAt).getTime();
  const requiredMs = getRandomMarketingSendDelayMs();
  const waitMs = requiredMs - elapsed;
  if (waitMs > 0) {
    marketingLog(mailbox, `waiting ${Math.round(waitMs / 1000)}s before next send on this mailbox`, {
      elapsedSec: Math.round(elapsed / 1000),
      requiredSec: Math.round(requiredMs / 1000),
    });
    await sleep(waitMs);
  }
}

async function getNextPendingLead(assignmentId) {
  return AppDataSource.getRepository(MarketingAssignmentLead).findOne({
    where: { assignmentId, sendStatus: 'pending' },
    relations: ['client'],
    order: { createdAt: 'ASC' },
  });
}

async function countPendingLeads(assignmentId) {
  return AppDataSource.getRepository(MarketingAssignmentLead).count({
    where: { assignmentId, sendStatus: 'pending' },
  });
}

async function sendOneMarketingLead(email, assignment, leadRow, meta = {}) {
  const leadRepo = AppDataSource.getRepository(MarketingAssignmentLead);
  const mb = email.address;
  const accountName = accountDisplayName(email);
  const client = leadRow.client;

  if (!client?.email) {
    leadRow.sendStatus = 'failed';
    leadRow.errorMessage = 'Lead has no email address';
    await leadRepo.save(leadRow);
    return { sent: 0, failed: 1 };
  }

  try {
    marketingLog(mb, 'composing email', {
      ...meta,
      to: client.email,
      aiCompose: isMarketingAiComposeEnabled(),
    });
    const composeStarted = Date.now();
    const composed = await composeForMarketingSend({
      lead: client,
      accountName,
      accountEmail: email.address,
    });
    marketingLog(mb, 'compose done', {
      ms: Date.now() - composeStarted,
      subject: String(composed.subject || '').slice(0, 60),
    });

    const useSmtp = hasAppPasswordCredentials(email) && !hasNylasCredentials(email);
    // Prefer Nylas when both are present; SMTP path used for app-password-only mailboxes
    // and when channel is smtp. Channel passed via meta.channel.
    const channel = meta.channel || (hasNylasCredentials(email) ? 'nylas' : 'smtp');

    let result;
    if (channel === 'smtp' || (useSmtp && channel !== 'nylas')) {
      if (!hasAppPasswordCredentials(email)) {
        leadRow.sendStatus = 'failed';
        leadRow.errorMessage = 'Mailbox is missing Google App Password';
        leadRow.subject = composed.subject;
        leadRow.body = composed.body;
        await leadRepo.save(leadRow);
        return { sent: 0, failed: 1 };
      }
      result = await sendSmtpEmail({
        fromEmail: email.address,
        fromName: accountName,
        appPassword: email.appPassword,
        toEmail: client.email,
        toName: [client.firstName, client.lastName].filter(Boolean).join(' ') || client.email,
        subject: composed.subject,
        body: composed.body,
      });
    } else {
      result = await sendNylasEmail({
        grantId: email.grantId,
        nylasKey: email.nylasKey,
        toEmail: client.email,
        toName: [client.firstName, client.lastName].filter(Boolean).join(' ') || client.email,
        subject: composed.subject,
        body: composed.body,
      });
    }

    if (!result.ok) {
      leadRow.sendStatus = 'failed';
      leadRow.errorMessage = result.error || (channel === 'smtp' ? 'SMTP send failed' : 'Nylas send failed');
      leadRow.subject = composed.subject;
      leadRow.body = composed.body;
      await leadRepo.save(leadRow);
      return { sent: 0, failed: 1 };
    }

    leadRow.sendStatus = 'sent';
    leadRow.subject = composed.subject;
    leadRow.body = composed.body;
    leadRow.nylasMessageId = result.messageId || null;
    leadRow.sentAt = new Date();
    leadRow.errorMessage = null;
    await leadRepo.save(leadRow);
    await markClientSent(client, email.address);
    marketingLog(mb, 'lead sent', { ...meta, channel, messageId: result.messageId });
    return { sent: 1, failed: 0 };
  } catch (err) {
    leadRow.sendStatus = 'failed';
    leadRow.errorMessage = err.message || String(err);
    await leadRepo.save(leadRow);
    marketingLog(mb, 'lead failed', { ...meta, error: err.message || String(err) });
    return { sent: 0, failed: 1 };
  }
}

async function loadMarketingWorkloads(date, eligibleRows) {
  const emailRepo = AppDataSource.getRepository(Email);
  const assignmentRepo = AppDataSource.getRepository(MarketingAssignment);
  const workloads = [];

  for (const row of eligibleRows) {
    const email = await emailRepo.findOne({
      where: { id: row.emailId, deletedAt: null },
      relations: ['account'],
    });
    if (!email || !canAssignToEmail(email, row.marketingChannel || 'nylas')) continue;

    const assignment = await assignmentRepo.findOne({
      where: { emailId: row.emailId, assignmentDate: date },
    });
    if (!assignment) continue;

    const pending = await countPendingLeads(assignment.id);
    if (pending === 0) continue;

    workloads.push({
      emailId: row.emailId,
      address: row.address,
      email,
      assignment,
      initialPending: pending,
      channel: row.marketingChannel || 'nylas',
    });
  }
  return workloads;
}

async function processMailboxOneRound(workload, roundIndex, totalRounds) {
  const { email, assignment, address } = workload;
  const pending = await countPendingLeads(assignment.id);
  if (pending === 0) return { sent: 0, failed: 0, skipped: true };

  const canSend = await marketingCanSendAnother(email, assignment.assignmentDate);
  if (!canSend) {
    marketingLog(address, 'skipped — outreach daily limit reached for this mailbox', {
      round: roundIndex + 1,
    });
    return { sent: 0, failed: 0, skipped: true, limitReached: true };
  }

  await waitForMailboxSendSpacing(assignment.id, address);

  const leadRow = await getNextPendingLead(assignment.id);
  if (!leadRow) return { sent: 0, failed: 0, skipped: true };

  return sendOneMarketingLead(email, assignment, leadRow, {
    round: roundIndex + 1,
    totalRounds,
    pendingBefore: pending,
    channel: workload.channel || 'nylas',
  });
}

async function finalizeMarketingWorkloads(workloads) {
  const repo = AppDataSource.getRepository(MarketingAssignment);
  for (const w of workloads) {
    const pending = await countPendingLeads(w.assignment.id);
    const fresh = await repo.findOne({ where: { id: w.assignment.id } });
    if (!fresh) continue;
    fresh.running = false;
    if (pending === 0) {
      const failed = await AppDataSource.getRepository(MarketingAssignmentLead).count({
        where: { assignmentId: w.assignment.id, sendStatus: 'failed' },
      });
      const sent = await AppDataSource.getRepository(MarketingAssignmentLead).count({
        where: { assignmentId: w.assignment.id, sendStatus: 'sent' },
      });
      fresh.status = failed > 0 && sent === 0 ? 'failed' : sent > 0 ? 'completed' : 'assigned';
    } else {
      fresh.status = 'assigned';
    }
    await repo.save(fresh);
  }
}

/**
 * Round-robin: for each message index, every mailbox batch sends one email (up to N parallel),
 * then next batch, until all accounts have sent that message; repeat for message #2, etc.
 */
async function runMarketingRoundRobin(eligible, date, batchSize) {
  marketingOrchestratorActive = true;
  let totalSent = 0;
  let totalFailed = 0;

  try {
    const workloads = await loadMarketingWorkloads(date, eligible);
    if (!workloads.length) {
      marketingLog(null, 'round-robin: no workloads');
      return { totalSent, totalFailed };
    }

    const maxRounds = Math.max(...workloads.map((w) => w.initialPending));
    marketingLog(null, 'round-robin started', {
      mailboxes: workloads.length,
      batchSize,
      maxRounds,
    });

    for (let round = 0; round < maxRounds; round += 1) {
      const roundNum = round + 1;
      const batches = chunkArray(workloads, batchSize);

      marketingLog(null, `message round ${roundNum}/${maxRounds}`, { batches: batches.length });

      for (let b = 0; b < batches.length; b += 1) {
        const batch = batches[b];
        const batchFrom = b * batchSize + 1;
        const batchTo = batchFrom + batch.length - 1;
        marketingLog(null, `round ${roundNum} batch accounts ${batchFrom}-${batchTo}`, {
          addresses: batch.map((w) => w.address),
        });

        const assignmentIds = batch.map((w) => w.assignment.id);
        await setAssignmentsRunning(assignmentIds, true);

        try {
          const results = await Promise.all(
            batch.map((w) => processMailboxOneRound(w, round, maxRounds))
          );
          for (const r of results) {
            totalSent += r.sent || 0;
            totalFailed += r.failed || 0;
          }
        } finally {
          await setAssignmentsRunning(assignmentIds, false);
        }
      }
    }

    await finalizeMarketingWorkloads(workloads);
    marketingLog(null, 'round-robin finished', { totalSent, totalFailed, mailboxes: workloads.length });
    return { totalSent, totalFailed };
  } finally {
    marketingOrchestratorActive = false;
  }
}

function parseDelayEnvMs(name, fallback) {
  const parsed = parseInt(process.env[name] || String(fallback), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getMarketingSendDelayConfig() {
  const minMs = parseDelayEnvMs(
    'MARKETING_SEND_DELAY_MIN_MS',
    DEFAULT_MARKETING_SEND_DELAY_MIN_MS
  );
  const maxMs = parseDelayEnvMs(
    'MARKETING_SEND_DELAY_MAX_MS',
    DEFAULT_MARKETING_SEND_DELAY_MAX_MS
  );
  return {
    minMs: Math.min(minMs, maxMs),
    maxMs: Math.max(minMs, maxMs),
  };
}

/** Independent uniform random delay in [minMs, maxMs] — called before every send on a mailbox. */
export function getRandomMarketingSendDelayMs() {
  const { minMs, maxMs } = getMarketingSendDelayConfig();
  if (maxMs <= minMs) return minMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

/** Default on; set MARKETING_USE_AI_COMPOSE=false to use static templates only. */
export function isMarketingAiComposeEnabled() {
  const v = String(process.env.MARKETING_USE_AI_COMPOSE ?? 'true')
    .trim()
    .toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no' && v !== 'off';
}

async function composeForMarketingSend({ lead, accountName, accountEmail }) {
  if (isMarketingAiComposeEnabled()) {
    return composeLeadOutboundEmailWithAi({
      lead,
      accountName,
      accountEmail,
      messageType: 'outreach',
    });
  }
  return composeLeadOutboundEmail({
    lead,
    accountName,
    accountEmail,
    messageType: 'outreach',
  });
}

export function getAssignmentDateString(input) {
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

export function isEmailAccountBlocked(emailRow) {
  const status = String(emailRow?.status || '').toLowerCase();
  return BLOCKED_EMAIL_STATUSES.has(status);
}

export function hasNylasCredentials(emailRow) {
  return Boolean(String(emailRow?.grantId || '').trim() && String(emailRow?.nylasKey || '').trim());
}

export { hasAppPasswordCredentials };

/** DB-only check: grant ID + Nylas API key present (no live Nylas call). */
export function getNylasCredentialsStatus(emailRow) {
  if (hasNylasCredentials(emailRow)) {
    return { status: 'ok', detail: 'Grant ID and API key configured' };
  }
  return { status: 'incomplete', detail: 'Grant ID and Nylas API key are required.' };
}

export function isMarketingEnabledForEmail(emailRow) {
  return emailRow?.marketingEnabled !== false;
}

/**
 * @param {'nylas'|'smtp'|'any'} [channel='nylas']
 */
export function canAssignToEmail(emailRow, channel = 'nylas') {
  if (!isMarketingEnabledForEmail(emailRow)) return false;
  if (isEmailAccountBlocked(emailRow)) return false;
  if (channel === 'smtp') return hasAppPasswordCredentials(emailRow);
  if (channel === 'any') {
    return hasNylasCredentials(emailRow) || hasAppPasswordCredentials(emailRow);
  }
  return hasNylasCredentials(emailRow);
}

export function canRunMarketing(emailRow, stats, channel = 'nylas') {
  if (!canAssignToEmail(emailRow, channel)) return false;
  if (marketingOrchestratorActive) return false;
  if (stats?.running) return false;
  return (stats?.pending || 0) > 0;
}

function accountDisplayName(emailRow) {
  const fromEmail = [emailRow?.firstName, emailRow?.lastName].filter(Boolean).join(' ').trim();
  if (fromEmail) return fromEmail;
  const acc = emailRow?.account;
  if (acc) {
    const name = [acc.firstName, acc.lastName].filter(Boolean).join(' ').trim();
    if (name) return name;
  }
  const local = String(emailRow?.address || '').split('@')[0];
  return local || 'Sender';
}

async function syncAssignmentTargetCount(assignmentId) {
  const leadRepo = AppDataSource.getRepository(MarketingAssignmentLead);
  const count = await leadRepo.count({ where: { assignmentId } });
  const assignmentRepo = AppDataSource.getRepository(MarketingAssignment);
  await assignmentRepo.update({ id: assignmentId }, { targetCount: count });
  return count;
}

async function getOrCreateAssignment(emailId, assignmentDate) {
  const repo = AppDataSource.getRepository(MarketingAssignment);
  let row = await repo.findOne({ where: { emailId, assignmentDate } });
  if (!row) {
    row = repo.create({
      emailId,
      assignmentDate,
      targetCount: 0,
      status: 'assigned',
      running: false,
    });
    row = await repo.save(row);
  }
  return row;
}

/**
 * Move still-pending (unsent) leads from past assignments into the current-day assignment
 * so leads assigned on a previous day (e.g. Friday) but never sent still appear as assigned
 * today and can be started. Only runs when `targetDate` is the real current local day, and
 * only touches assignments that are not actively running. Idempotent.
 */
async function carryForwardPendingMarketingAssignments(targetDate, emailId = null) {
  if (targetDate !== getAssignmentDateString()) return { moved: 0 };

  const assignmentRepo = AppDataSource.getRepository(MarketingAssignment);
  const leadRepo = AppDataSource.getRepository(MarketingAssignmentLead);

  const pastQb = assignmentRepo
    .createQueryBuilder('a')
    .where('a.assignmentDate < :date', { date: targetDate })
    .andWhere('a.running = false');
  if (emailId) pastQb.andWhere('a.emailId = :emailId', { emailId });
  const pastAssignments = await pastQb.getMany();
  if (!pastAssignments.length) return { moved: 0 };

  const pastIds = pastAssignments.map((a) => a.id);
  const pendingRows = await leadRepo
    .createQueryBuilder('mal')
    .select('mal.assignmentId', 'assignmentId')
    .addSelect('COUNT(*)', 'cnt')
    .where('mal.assignmentId IN (:...ids)', { ids: pastIds })
    .andWhere("mal.sendStatus = 'pending'")
    .groupBy('mal.assignmentId')
    .getRawMany();
  const pendingByAssignment = new Map(
    pendingRows.map((r) => [r.assignmentId, parseInt(String(r.cnt), 10) || 0])
  );

  let moved = 0;
  const affectedTargets = new Set();
  const affectedSources = new Set();

  for (const src of pastAssignments) {
    if ((pendingByAssignment.get(src.id) || 0) <= 0) continue;
    const target = await getOrCreateAssignment(src.emailId, targetDate);
    if (target.id === src.id) continue;
    const res = await leadRepo.update(
      { assignmentId: src.id, sendStatus: 'pending' },
      { assignmentId: target.id }
    );
    const cnt = res.affected || 0;
    if (cnt > 0) {
      moved += cnt;
      affectedTargets.add(target.id);
      affectedSources.add(src.id);
    }
  }

  for (const id of affectedTargets) {
    await syncAssignmentTargetCount(id);
    await assignmentRepo.update({ id }, { status: 'assigned', lastError: null });
  }
  for (const id of affectedSources) {
    await syncAssignmentTargetCount(id);
  }

  if (moved > 0) {
    marketingLog(null, 'carried forward unsent leads into today', {
      moved,
      targetDate,
      sources: affectedSources.size,
    });
  }

  return { moved };
}

async function getAssignmentStats(assignmentIds) {
  if (!assignmentIds.length) return new Map();
  const rows = await AppDataSource.getRepository(MarketingAssignmentLead)
    .createQueryBuilder('mal')
    .select('mal.assignmentId', 'assignmentId')
    .addSelect('mal.sendStatus', 'sendStatus')
    .addSelect('COUNT(*)', 'cnt')
    .where('mal.assignmentId IN (:...assignmentIds)', { assignmentIds })
    .groupBy('mal.assignmentId')
    .addGroupBy('mal.sendStatus')
    .getRawMany();

  const map = new Map();
  for (const id of assignmentIds) {
    map.set(id, { assigned: 0, pending: 0, sent: 0, failed: 0 });
  }
  for (const r of rows) {
    const id = r.assignmentId;
    const cnt = parseInt(String(r.cnt), 10) || 0;
    const entry = map.get(id) || { assigned: 0, pending: 0, sent: 0, failed: 0 };
    entry.assigned += cnt;
    if (r.sendStatus === 'pending') entry.pending += cnt;
    else if (r.sendStatus === 'sent') entry.sent += cnt;
    else if (r.sendStatus === 'failed') entry.failed += cnt;
    map.set(id, entry);
  }
  return map;
}

export async function setMarketingEnabled(emailId, enabled) {
  const emailRepo = AppDataSource.getRepository(Email);
  const email = await emailRepo.findOne({ where: { id: emailId, deletedAt: null } });
  if (!email) throw new Error('Email account not found');
  const next = Boolean(enabled);
  if (next && !hasNylasCredentials(email) && !hasAppPasswordCredentials(email)) {
    throw new Error('Grant ID + Nylas API key, or Google App Password, are required before enabling marketing');
  }
  email.marketingEnabled = next;
  await emailRepo.save(email);
  return { emailId: email.id, address: email.address, marketingEnabled: email.marketingEnabled };
}

export async function setMarketingAssignDefault(emailId, assignDefault) {
  const emailRepo = AppDataSource.getRepository(Email);
  const email = await emailRepo.findOne({ where: { id: emailId, deletedAt: null } });
  if (!email) throw new Error('Email account not found');

  const raw = assignDefault;
  if (raw === null || raw === undefined || raw === '') {
    email.marketingAssignDefault = null;
  } else {
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n < 1 || n > 500) {
      throw new Error('assignDefault must be between 1 and 500');
    }
    email.marketingAssignDefault = n;
  }

  await emailRepo.save(email);
  return {
    emailId: email.id,
    address: email.address,
    marketingAssignDefault: email.marketingAssignDefault,
  };
}

export async function getMarketingDashboard(assignmentDate, options = {}) {
  const date = getAssignmentDateString(assignmentDate);
  const channel = options.channel === 'smtp' ? 'smtp' : options.channel === 'any' ? 'any' : 'nylas';
  /** Legacy: when channel not set explicitly via options.channel, nylasOnly still applies. */
  const nylasOnly =
    options.channel != null
      ? channel === 'nylas'
      : options.nylasOnly !== false && options.nylasOnly !== 'false';

  // Bring forward leads assigned on a previous day but never sent, so they appear today.
  if (options.carryForward !== false) {
    try {
      await carryForwardPendingMarketingAssignments(date);
    } catch (err) {
      marketingLog(null, 'carry-forward failed (continuing)', { error: err.message || String(err) });
    }
  }

  const emailRepo = AppDataSource.getRepository(Email);
  let emailQb = emailRepo
    .createQueryBuilder('email')
    .leftJoinAndSelect('email.account', 'account')
    .where('email.deletedAt IS NULL');
  if (channel === 'smtp') {
    emailQb = emailQb.andWhere(
      `(email.app_password IS NOT NULL AND TRIM(email.app_password) <> '')`
    );
  } else if (nylasOnly || channel === 'nylas') {
    emailQb = emailQb.andWhere(
      `(email.grant_id IS NOT NULL AND TRIM(email.grant_id) <> '')
       AND (email.nylas_key IS NOT NULL AND TRIM(email.nylas_key) <> '')`
    );
  }
  const emails = await emailQb.orderBy('email.address', 'ASC').getMany();

  const todayStatsMap = await getMailboxTodayStatsByEmailId(
    emails.map((e) => ({ id: e.id, address: e.address }))
  );
  const { today, tomorrow } = getLocalTodayRange();

  const assignmentRepo = AppDataSource.getRepository(MarketingAssignment);
  const assignments = await assignmentRepo.find({ where: { assignmentDate: date } });
  const assignmentByEmail = new Map(assignments.map((a) => [a.emailId, a]));
  const statsMap = await getAssignmentStats(assignments.map((a) => a.id));

  const rows = emails.map((email) => {
    const nylas = getNylasCredentialsStatus(email);
    const assignment = assignmentByEmail.get(email.id) || null;
    const stats = assignment ? statsMap.get(assignment.id) : null;
    const counts = stats || { assigned: 0, pending: 0, sent: 0, failed: 0 };
    const dailyLimitSentBaseline = assignment?.dailyLimitSentBaseline ?? 0;
    const effectiveSentCount = effectiveSentForDailyLimit(counts.sent, dailyLimitSentBaseline);
    const outreachDailyLimit = resolveDailyLimitFromEmail(email, 10);

    const marketingEnabled = isMarketingEnabledForEmail(email);
    const todayStats = todayStatsMap.get(email.id) || {
      nylasMarketingToday: 0,
      gmailExtensionToday: 0,
      followupsSentToday: 0,
      messagesSentToday: 0,
    };

    return {
      emailId: email.id,
      address: email.address,
      nylasConnected: hasNylasCredentials(email),
      hasAppPassword: hasAppPasswordCredentials(email),
      marketingChannel: channel,
      marketingEnabled,
      marketingDailyLimit: email.marketingDailyLimit ?? null,
      marketingAssignDefault: email.marketingAssignDefault ?? null,
      emailStatus: email.status,
      nylasStatus: nylas.status,
      nylasDetail: nylas.detail,
      assignmentId: assignment?.id || null,
      targetCount: assignment?.targetCount ?? 0,
      assignedCount: counts.assigned,
      pendingCount: counts.pending,
      sentCount: counts.sent,
      dailyLimitSentBaseline,
      effectiveSentCount,
      dailyLimitRemaining: Math.max(0, outreachDailyLimit - counts.pending - effectiveSentCount),
      outreachDailyLimit,
      failedCount: counts.failed,
      running: Boolean(assignment?.running),
      canAssign: canAssignToEmail(email, channel === 'any' ? 'any' : channel),
      canRun: canRunMarketing(
        email,
        {
          pending: counts.pending,
          running: assignment?.running,
        },
        channel === 'any' ? 'any' : channel
      ),
      lastError: assignment?.lastError || null,
      messagesSentToday: todayStats.messagesSentToday,
      followupsSentToday: todayStats.followupsSentToday,
      nylasMarketingToday: todayStats.nylasMarketingToday,
      gmailExtensionToday: todayStats.gmailExtensionToday,
    };
  });

  const sendDelay = getMarketingSendDelayConfig();

  return {
    assignmentDate: date,
    progressDate: today.toISOString().slice(0, 10),
    progressDateEnd: tomorrow.toISOString(),
    nylasOnly: channel === 'nylas' || nylasOnly,
    channel,
    rows,
    checkedAt: new Date().toISOString(),
    sendDelayMinMs: sendDelay.minMs,
    sendDelayMaxMs: sendDelay.maxMs,
    sendDelayMinMinutes: Math.round(sendDelay.minMs / 60000),
    sendDelayMaxMinutes: Math.round(sendDelay.maxMs / 60000),
  };
}

export async function assignLeadsToEmail(emailId, count, assignmentDate, filters = {}) {
  const date = getAssignmentDateString(assignmentDate);
  const channel = filters.channel === 'smtp' ? 'smtp' : 'nylas';
  let requested = Math.min(500, Math.max(0, parseInt(String(count), 10) || 0));
  if (!requested) throw new Error('count must be at least 1');

  const emailRepo = AppDataSource.getRepository(Email);
  const email = await emailRepo.findOne({
    where: { id: emailId, deletedAt: null },
    relations: ['account'],
  });
  if (!email) throw new Error('Email account not found');

  const remainingSlots = await getMarketingDailyLimitState(email, date);
  if (remainingSlots) {
    requested = Math.min(requested, remainingSlots.remaining);
  }
  const n = requested;
  if (!n) {
    return {
      assigned: 0,
      message: 'Outreach daily limit already reached (follow-up limit is separate)',
    };
  }

  if (!canAssignToEmail(email, channel)) {
    if (!isMarketingEnabledForEmail(email)) {
      throw new Error('Marketing is disabled for this mailbox');
    }
    throw new Error(
      isEmailAccountBlocked(email)
        ? `Cannot assign leads to account with status "${email.status}"`
        : channel === 'smtp'
          ? 'Google App Password is required for this mailbox'
          : 'Grant ID and Nylas API key are required for this mailbox'
    );
  }

  // Same pool as Gmail extension: status=new only, atomically claimed as ready in DB.
  const leads = await fetchUncontactedVerifiedLeads({
    count: n,
    verifiedOnly: true,
    assignmentDate: date,
    leadFilterId: filters.leadFilterId,
    leadFilterIds: filters.leadFilterIds,
    leadFilterMode: filters.leadFilterMode,
    location: filters.location,
    industry: filters.industry,
  });
  if (!leads.length) {
    return {
      assigned: 0,
      message: 'No available new Millions-verified leads to assign (ready/sent leads are excluded)',
    };
  }

  const assignment = await getOrCreateAssignment(email.id, date);
  const leadRepo = AppDataSource.getRepository(MarketingAssignmentLead);
  const entities = leads.map((client) =>
    leadRepo.create({
      assignmentId: assignment.id,
      clientId: client.id,
      sendStatus: 'pending',
    })
  );
  await leadRepo.save(entities);

  assignment.targetCount = await syncAssignmentTargetCount(assignment.id);
  assignment.status = 'assigned';
  assignment.lastError = null;
  await AppDataSource.getRepository(MarketingAssignment).save(assignment);

  return { assigned: leads.length, assignmentId: assignment.id };
}

export async function getAssignmentLeadsForEmail(emailId, assignmentDate) {
  const date = getAssignmentDateString(assignmentDate);
  const emailRepo = AppDataSource.getRepository(Email);
  const email = await emailRepo.findOne({ where: { id: emailId, deletedAt: null } });
  if (!email) throw new Error('Email account not found');

  const assignmentRepo = AppDataSource.getRepository(MarketingAssignment);
  const assignment = await assignmentRepo.findOne({ where: { emailId, assignmentDate: date } });
  if (!assignment) {
    return {
      emailId,
      address: email.address,
      assignmentDate: date,
      assignmentId: null,
      leads: [],
    };
  }

  const rows = await AppDataSource.getRepository(MarketingAssignmentLead).find({
    where: { assignmentId: assignment.id },
    relations: ['client'],
    order: { createdAt: 'ASC' },
  });

  return {
    emailId,
    address: email.address,
    assignmentDate: date,
    assignmentId: assignment.id,
    leads: rows.map((row) => ({
      assignmentLeadId: row.id,
      clientId: row.clientId,
      sendStatus: row.sendStatus,
      email: row.client?.email || '',
      firstName: row.client?.firstName || '',
      lastName: row.client?.lastName || '',
      companyName: row.client?.companyName || '',
      millionsStatus: row.client?.millionsStatus || null,
      clientStatus: row.client?.status || null,
      canUnassign: row.sendStatus === 'pending',
    })),
  };
}

export async function unassignMarketingLead(assignmentLeadId) {
  const leadRepo = AppDataSource.getRepository(MarketingAssignmentLead);
  const row = await leadRepo.findOne({
    where: { id: assignmentLeadId },
    relations: ['assignment'],
  });
  if (!row) throw new Error('Assigned lead not found');
  if (row.sendStatus !== 'pending') {
    throw new Error('Only pending leads can be unassigned');
  }

  const clientId = row.clientId;
  const assignmentId = row.assignmentId;
  await leadRepo.remove(row);
  await resetLeadsFromReady([clientId]);
  await syncAssignmentTargetCount(assignmentId);

  const assignmentRepo = AppDataSource.getRepository(MarketingAssignment);
  const remaining = await leadRepo.count({ where: { assignmentId } });
  if (remaining === 0) {
    await assignmentRepo.update({ id: assignmentId }, { status: 'assigned', targetCount: 0 });
  }

  return { unassigned: true, assignmentLeadId, clientId };
}

/**
 * Unassign every pending marketing lead for the given assignment date.
 * When emailId is set, only that mailbox's assignment is cleared.
 */
export async function unassignAllPendingMarketingLeads({ assignmentDate, emailId } = {}) {
  const date = getAssignmentDateString(assignmentDate);
  const assignmentRepo = AppDataSource.getRepository(MarketingAssignment);
  const leadRepo = AppDataSource.getRepository(MarketingAssignmentLead);

  let assignmentIds = [];
  if (emailId) {
    const one = await assignmentRepo.findOne({
      where: { emailId, assignmentDate: date },
    });
    if (one) assignmentIds = [one.id];
  } else {
    const all = await assignmentRepo.find({
      where: { assignmentDate: date },
      select: ['id'],
    });
    assignmentIds = all.map((a) => a.id);
  }

  if (!assignmentIds.length) {
    return { unassigned: 0, assignmentDate: date, emailId: emailId || null };
  }

  const pendingRows = await leadRepo.find({
    where: { assignmentId: In(assignmentIds), sendStatus: 'pending' },
    select: ['id'],
  });

  let unassigned = 0;
  for (const row of pendingRows) {
    await unassignMarketingLead(row.id);
    unassigned += 1;
  }

  return { unassigned, assignmentDate: date, emailId: emailId || null };
}

function resolveMarketingDailyLimit(row, defaultCount) {
  return resolveDailyLimitFromEmail(
    { marketingDailyLimit: row?.marketingDailyLimit },
    defaultCount
  );
}

/** Leads still needed today so pending + effective sent reaches the daily limit. */
function resolveMarketingAssignCount(row, defaultCount) {
  const limit = resolveMarketingDailyLimit(row, defaultCount);
  const pending = Math.max(0, parseInt(String(row?.pendingCount), 10) || 0);
  const sent = effectiveSentForDailyLimit(row?.sentCount, row?.dailyLimitSentBaseline);
  return Math.max(0, Math.min(500, limit - pending - sent));
}

async function getRemainingAssignSlotsForEmail(email, assignmentDate) {
  const state = await getMarketingDailyLimitState(email, assignmentDate);
  return state.remaining;
}

/**
 * Reset daily-limit sent counters for assignment date (all mailboxes or one).
 * Does not delete sent leads; sets baseline so assign/send can run again up to the daily limit.
 */
export async function resetDailySentCount(assignmentDate, emailId = null) {
  const date = getAssignmentDateString(assignmentDate);
  const assignmentRepo = AppDataSource.getRepository(MarketingAssignment);
  const where = { assignmentDate: date };
  if (emailId) where.emailId = emailId;

  const assignments = await assignmentRepo.find({ where });
  if (!assignments.length) {
    return {
      assignmentDate: date,
      emailId: emailId || null,
      mailboxesReset: 0,
      message: 'No marketing assignments found for this date',
    };
  }

  let mailboxesReset = 0;
  for (const assignment of assignments) {
    const statsMap = await getAssignmentStats([assignment.id]);
    const counts = statsMap.get(assignment.id) || { sent: 0 };
    assignment.dailyLimitSentBaseline = counts.sent || 0;
    await assignmentRepo.save(assignment);
    mailboxesReset += 1;
  }

  marketingLog(null, 'reset daily sent baseline for limit', {
    assignmentDate: date,
    emailId: emailId || 'all',
    mailboxesReset,
  });

  return {
    assignmentDate: date,
    emailId: emailId || null,
    mailboxesReset,
    message:
      mailboxesReset === 1
        ? 'Daily sent count reset for 1 mailbox. You can assign and send again up to the daily limit.'
        : `Daily sent count reset for ${mailboxesReset} mailboxes. You can assign and send again up to each daily limit.`,
  };
}

export async function assignLeadsToAll(countPerAccount, assignmentDate, filters = {}) {
  const date = getAssignmentDateString(assignmentDate);
  const channel = filters.channel === 'smtp' ? 'smtp' : 'nylas';
  const defaultCount = Math.max(1, Math.min(500, parseInt(String(countPerAccount), 10) || 0));
  const dashboard = await getMarketingDashboard(date, { channel });
  const eligible = dashboard.rows.filter((r) => r.marketingEnabled && r.canAssign);
  if (!eligible.length) {
    return { totalAssigned: 0, accounts: [] };
  }

  const accounts = [];
  let totalAssigned = 0;
  for (const row of eligible) {
    const count = resolveMarketingAssignCount(row, defaultCount);
    const dailyLimit = resolveMarketingDailyLimit(row, defaultCount);
    const alreadyAllocated =
      (row.pendingCount || 0) + effectiveSentForDailyLimit(row.sentCount, row.dailyLimitSentBaseline);
    if (count === 0) {
      accounts.push({
        emailId: row.emailId,
        address: row.address,
        assigned: 0,
        requestedCount: 0,
        dailyLimit,
        alreadyAllocated,
        skipped: true,
        message: 'Daily limit already reached',
        usedDailyLimit: row.marketingDailyLimit != null && row.marketingDailyLimit > 0,
      });
      continue;
    }
    try {
      const result = await assignLeadsToEmail(row.emailId, count, date, {
        ...filters,
        channel,
      });
      totalAssigned += result.assigned || 0;
      accounts.push({
        emailId: row.emailId,
        address: row.address,
        assigned: result.assigned || 0,
        requestedCount: count,
        dailyLimit,
        alreadyAllocated,
        message: result.message || null,
        usedDailyLimit: row.marketingDailyLimit != null && row.marketingDailyLimit > 0,
      });
    } catch (err) {
      accounts.push({
        emailId: row.emailId,
        address: row.address,
        assigned: 0,
        requestedCount: count,
        dailyLimit,
        alreadyAllocated,
        error: err.message || String(err),
      });
    }
  }

  return { totalAssigned, accounts, channel };
}

async function markClientSent(client, mailboxAddress) {
  const clientRepo = AppDataSource.getRepository(Client);
  const currentSentBy = client.sentBy || [];
  const sentBy = currentSentBy.includes(mailboxAddress)
    ? currentSentBy
    : [...currentSentBy, mailboxAddress];
  await clientRepo.update(
    { id: client.id },
    {
      isSent: true,
      lastSent: new Date(),
      sentBy,
      status: 'sent',
    }
  );
}

export async function runMarketingForEmail(emailId, assignmentDate, options = {}) {
  const date = getAssignmentDateString(assignmentDate);
  const channel = options.channel === 'smtp' ? 'smtp' : 'nylas';
  const emailRepo = AppDataSource.getRepository(Email);
  const email = await emailRepo.findOne({
    where: { id: emailId, deletedAt: null },
    relations: ['account'],
  });
  if (!email) throw new Error('Email account not found');

  if (marketingOrchestratorActive) {
    throw new Error('Start-all is in progress. Wait for round-robin to finish or reset stuck sending.');
  }

  const mb = email.address;
  marketingLog(mb, 'run started', { emailId, assignmentDate: date, channel });

  if (!isMarketingEnabledForEmail(email)) {
    throw new Error('Marketing is disabled for this mailbox');
  }

  if (!canAssignToEmail(email, channel)) {
    throw new Error(
      channel === 'smtp'
        ? 'Mailbox is not eligible for SMTP marketing (status or missing App Password)'
        : 'Mailbox is not eligible for marketing (status or missing Nylas credentials)'
    );
  }

  // Pull any unsent leads from previous days into today's assignment for this mailbox first.
  try {
    await carryForwardPendingMarketingAssignments(date, emailId);
  } catch (err) {
    marketingLog(mb, 'carry-forward failed (continuing)', { error: err.message || String(err) });
  }

  const assignmentRepo = AppDataSource.getRepository(MarketingAssignment);
  const assignment = await assignmentRepo.findOne({ where: { emailId, assignmentDate: date } });
  if (!assignment) throw new Error('No leads assigned for today. Assign leads first.');

  const leadRepo = AppDataSource.getRepository(MarketingAssignmentLead);
  const pendingRows = await leadRepo.find({
    where: { assignmentId: assignment.id, sendStatus: 'pending' },
    relations: ['client'],
    order: { createdAt: 'ASC' },
  });

  if (!pendingRows.length) {
    marketingLog(mb, 'no pending leads');
    return { sent: 0, failed: 0, skipped: 0, message: 'No pending leads to send' };
  }

  const claim = await assignmentRepo.update(
    { id: assignment.id, running: false },
    { running: true, status: 'running', lastError: null }
  );
  if (!claim.affected) {
    marketingLog(mb, 'skipped — already running (another worker owns this mailbox)');
    throw new Error('Marketing is already running for this mailbox');
  }

  marketingLog(mb, 'claimed assignment', {
    assignmentId: assignment.id,
    pending: pendingRows.length,
    channel,
  });

  let sent = 0;
  let failed = 0;

  try {
    for (let i = 0; i < pendingRows.length; i += 1) {
      if (!(await marketingCanSendAnother(email, date))) {
        marketingLog(mb, 'daily outreach limit reached — stopping send loop');
        break;
      }
      await waitForMailboxSendSpacing(assignment.id, mb);

      const row = await getNextPendingLead(assignment.id);
      if (!row) break;

      const result = await sendOneMarketingLead(email, assignment, row, {
        index: i + 1,
        total: pendingRows.length,
        mode: 'single-mailbox',
        channel,
      });
      sent += result.sent;
      failed += result.failed;
    }
  } finally {
    const fresh = await assignmentRepo.findOne({ where: { id: assignment.id } });
    if (fresh) {
      fresh.running = false;
      fresh.status = failed > 0 && sent === 0 ? 'failed' : sent > 0 ? 'completed' : 'assigned';
      if (failed > 0 && sent === 0) {
        fresh.lastError = 'All sends failed for this batch';
      }
      await assignmentRepo.save(fresh);
    }
    marketingLog(mb, 'run finished', { sent, failed, total: pendingRows.length, channel });
  }

  return { sent, failed, total: pendingRows.length };
}

/**
 * Start-all: round-robin batches — each batch sends one email per mailbox, then the next batch,
 * repeating for message #2, #3, … with random 3–5 min spacing per mailbox between its own sends.
 */
export async function runMarketingForAll(assignmentDate, options = {}) {
  const date = getAssignmentDateString(assignmentDate);
  const channel = options.channel === 'smtp' ? 'smtp' : 'nylas';

  if (marketingOrchestratorActive) {
    throw new Error('Marketing send is already in progress. Wait for it to finish or use Reset stuck sending.');
  }

  const releasedOrphans = await releaseAllRunningForAssignmentDate(date);
  if (releasedOrphans > 0) {
    marketingLog(null, 'cleared running flags before start-all', { count: releasedOrphans, date });
  }
  const released = await releaseStaleRunningAssignments(date);
  if (released > 0) {
    marketingLog(null, 'released stale running assignments before start-all', { count: released });
  }

  const dashboard = await getMarketingDashboard(date, { channel });
  const enabledRows = dashboard.rows.filter((r) => r.marketingEnabled);
  const eligible = enabledRows.filter(
    (r) => r.canAssign && (r.pendingCount || 0) > 0 && !r.running
  );
  const skipped = [];
  const batchSize = getMarketingMaxParallelMailboxes();

  for (const row of enabledRows) {
    if (eligible.some((e) => e.emailId === row.emailId)) continue;
    let reason = 'not eligible';
    if (marketingOrchestratorActive) reason = 'orchestrator already running';
    else if (row.running) reason = 'already running';
    else if ((row.pendingCount || 0) === 0) reason = 'no pending leads — assign first';
    else if (!row.canAssign) {
      reason =
        channel === 'smtp'
          ? 'missing App Password or blocked status'
          : 'missing Nylas setup or blocked status';
    }
    skipped.push({ emailId: row.emailId, address: row.address, reason });
  }

  marketingLog(null, 'start-all round-robin queued', {
    eligible: eligible.length,
    skipped: skipped.length,
    batchSize,
    assignmentDate: date,
    channel,
  });

  if (eligible.length > 0) {
    void runMarketingRoundRobin(eligible, date, batchSize).catch((err) => {
      marketingLog(null, 'round-robin crashed', { error: err.message || String(err) });
      marketingOrchestratorActive = false;
    });
  }

  return {
    started: eligible.length,
    skipped: skipped.length,
    skippedDetails: skipped,
    emailIds: eligible.map((r) => r.emailId),
    concurrency: batchSize,
    releasedStaleRunning: released,
    channel,
    message:
      eligible.length > 0
        ? `Round-robin started for ${eligible.length} mailbox(es): batches of ${batchSize} send one email each, then the next batch, then message #2 for all, etc. (random 3–5 min between sends on the same mailbox). Watch logs [marketing] / [nylas-send] / [smtp-send].`
        : 'No mailboxes were started. Assign leads and ensure accounts are enabled with pending sends.',
  };
}
