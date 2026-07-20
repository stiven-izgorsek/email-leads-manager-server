import { In } from 'typeorm';
import { AppDataSource } from '../config/database.js';
import { Email } from '../entities/Email.js';
import { Client } from '../entities/Client.js';
import { FollowupAssignment } from '../entities/FollowupAssignment.js';
import { FollowupAssignmentLead } from '../entities/FollowupAssignmentLead.js';
import { composeLeadOutboundEmail } from '../controllers/templateController.js';
import { sendNylasEmail } from './nylasSendService.js';
import { resolveOriginalOutboundForFollowup, loadStoredMarketingNylasMessageMap } from './nylasOriginalMessageService.js';
import { leadIsEligibleForFollowup } from './followupReplyGuardService.js';
import { sleep } from '../utils/nylasRateLimit.js';
import { getMailboxTodayStatsByEmailId, getLocalTodayRange } from './mailboxTodayOutboundService.js';
import {
  effectiveSentForDailyLimit,
  followupCanSendAnother,
  getFollowupDailyLimitState,
  resolveDailyLimitFromEmail,
} from './dailyLimitService.js';
import {
  getAssignmentDateString,
  hasNylasCredentials,
  getNylasCredentialsStatus,
  isEmailAccountBlocked,
  getMarketingSendDelayConfig,
  getRandomMarketingSendDelayMs,
} from './marketingService.js';

const DEFAULT_FOLLOWUP_MAX_PARALLEL_MAILBOXES = 5;
const DEFAULT_STUCK_RUNNING_MS = 45 * 60 * 1000;

let followupOrchestratorActive = false;
/** Set by POST /stop-all; checked between sends and during spacing waits. */
let followupStopRequested = false;
let followupAssignAllActive = false;
/** @type {null | { startedAt: string, finishedAt?: string, accountsTotal?: number, accountsDone?: number, totalAssigned?: number, totalSkippedNoThread?: number, totalSkippedWithReply?: number, error?: string }} */
let followupAssignAllSummary = null;

export function isFollowupAssignAllActive() {
  return followupAssignAllActive;
}

export function getFollowupAssignAllSummary() {
  return followupAssignAllSummary;
}

export function clearFollowupStopRequest() {
  followupStopRequested = false;
}

function isFollowupStopRequested() {
  return followupStopRequested;
}

/** Sleep in small chunks so Stop all can interrupt long spacing waits. */
async function sleepUnlessFollowupStopped(ms) {
  const chunkMs = 500;
  let remaining = Math.max(0, ms);
  while (remaining > 0) {
    if (isFollowupStopRequested()) return false;
    const step = Math.min(chunkMs, remaining);
    await sleep(step);
    remaining -= step;
  }
  return !isFollowupStopRequested();
}

function followupLog(mailbox, message, extra) {
  const ts = new Date().toISOString();
  const suffix =
    extra && typeof extra === 'object' && Object.keys(extra).length > 0
      ? ` ${JSON.stringify(extra)}`
      : '';
  console.log(`[followup] ${ts} ${mailbox || '—'} ${message}${suffix}`);
}

function parsePositiveIntEnv(name, fallback) {
  const parsed = parseInt(process.env[name] || String(fallback), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getFollowupMaxParallelMailboxes() {
  return parsePositiveIntEnv(
    'FOLLOWUP_MAX_PARALLEL_MAILBOXES',
    parsePositiveIntEnv('MARKETING_MAX_PARALLEL_MAILBOXES', DEFAULT_FOLLOWUP_MAX_PARALLEL_MAILBOXES)
  );
}

function getStuckRunningMaxAgeMs() {
  return parsePositiveIntEnv('FOLLOWUP_STUCK_RUNNING_MS', DEFAULT_STUCK_RUNNING_MS);
}

export function isFollowupOrchestratorActive() {
  return followupOrchestratorActive;
}

export function isFollowupEnabledForEmail(emailRow) {
  return emailRow?.followupEnabled !== false;
}

export function canAssignFollowupToEmail(emailRow) {
  if (!isFollowupEnabledForEmail(emailRow)) return false;
  if (isEmailAccountBlocked(emailRow)) return false;
  return hasNylasCredentials(emailRow);
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

/** End of calendar day (local) that is `daysBefore` days before today. */
export function computeSentOnOrBefore(daysBefore) {
  const days = Math.min(365, Math.max(1, parseInt(String(daysBefore), 10) || 7));
  const cutoff = new Date();
  cutoff.setHours(23, 59, 59, 999);
  cutoff.setDate(cutoff.getDate() - days);
  return { days, cutoff };
}

function resolveDailyLimit(row, defaultCount) {
  return resolveDailyLimitFromEmail(
    { marketingDailyLimit: row?.marketingDailyLimit },
    defaultCount
  );
}

function resolveAssignCount(row, defaultCount) {
  const limit = resolveDailyLimit(row, defaultCount);
  const pending = Math.max(0, parseInt(String(row?.pendingCount), 10) || 0);
  const sent = effectiveSentForDailyLimit(row?.sentCount, row?.dailyLimitSentBaseline);
  const remaining = Math.max(0, limit - pending - sent);
  const cap = Math.max(1, Math.min(500, parseInt(String(defaultCount), 10) || 10));
  if (row?.dailyLimitRemaining != null) {
    return Math.max(0, Math.min(cap, remaining, parseInt(String(row.dailyLimitRemaining), 10) || 0));
  }
  return Math.max(0, Math.min(cap, remaining));
}

async function getAssignmentStats(assignmentIds) {
  if (!assignmentIds.length) return new Map();
  const rows = await AppDataSource.getRepository(FollowupAssignmentLead)
    .createQueryBuilder('fal')
    .select('fal.assignmentId', 'assignmentId')
    .addSelect('fal.sendStatus', 'sendStatus')
    .addSelect('COUNT(*)', 'cnt')
    .where('fal.assignmentId IN (:...assignmentIds)', { assignmentIds })
    .groupBy('fal.assignmentId')
    .addGroupBy('fal.sendStatus')
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

async function getOrCreateAssignment(emailId, assignmentDate, daysBefore) {
  const repo = AppDataSource.getRepository(FollowupAssignment);
  let row = await repo.findOne({ where: { emailId, assignmentDate } });
  const days = Math.min(365, Math.max(1, parseInt(String(daysBefore), 10) || 7));
  if (!row) {
    row = repo.create({
      emailId,
      assignmentDate,
      daysBefore: days,
      targetCount: 0,
      status: 'assigned',
      running: false,
    });
    row = await repo.save(row);
  } else if (row.daysBefore !== days) {
    row.daysBefore = days;
    await repo.save(row);
  }
  return row;
}

async function syncAssignmentTargetCount(assignmentId) {
  const count = await AppDataSource.getRepository(FollowupAssignmentLead).count({
    where: { assignmentId },
  });
  await AppDataSource.getRepository(FollowupAssignment).update(
    { id: assignmentId },
    { targetCount: count }
  );
  return count;
}

/**
 * Clients sent from this mailbox at least `daysBefore` ago with no reply / follow-up yet.
 * @param {object} email
 * @param {number} daysBefore
 * @param {string} assignmentDate
 * @param {number|{ limit?: number, excludeClientIds?: string[] }} limitOrOptions
 */
export async function fetchFollowupCandidateClients(email, daysBefore, assignmentDate, limitOrOptions = 500) {
  const mailbox = String(email.address || '').trim().toLowerCase();
  const { cutoff } = computeSentOnOrBefore(daysBefore);
  const opts =
    typeof limitOrOptions === 'number'
      ? { limit: limitOrOptions, excludeClientIds: [] }
      : {
          limit: limitOrOptions?.limit ?? 500,
          excludeClientIds: limitOrOptions?.excludeClientIds ?? [],
        };
  const max = Math.min(500, Math.max(1, parseInt(String(opts.limit), 10) || 500));
  const excludeClientIds = (opts.excludeClientIds || []).filter(Boolean);

  const clientRepo = AppDataSource.getRepository(Client);
  const qb = clientRepo
    .createQueryBuilder('client')
    .where('client.deletedAt IS NULL')
    .andWhere('client.isSent = :isSent', { isSent: true })
    .andWhere('(client.isFollowup = false OR client.isFollowup IS NULL)')
    .andWhere('(client.isReplied = false OR client.isReplied IS NULL)')
    .andWhere('client.lastSent IS NOT NULL')
    .andWhere('client.lastSent <= :cutoff', { cutoff })
    .andWhere(
      `(
        LOWER(COALESCE(client.sentBy, '')) LIKE :mailbox
        OR EXISTS (
          SELECT 1 FROM marketing_assignment_lead mal
          INNER JOIN marketing_assignment ma ON ma.id = mal.assignment_id
          WHERE mal.client_id = client.id
            AND ma.email_id = :emailId
            AND mal.send_status = 'sent'
        )
      )`
    )
    .setParameter('emailId', email.id)
    .setParameter('mailbox', `%${mailbox}%`)
    .andWhere(
      `NOT EXISTS (
        SELECT 1 FROM followup_assignment_lead fal
        WHERE fal.client_id = client.id AND fal.send_status = 'pending'
      )`
    )
    .andWhere(
      `NOT EXISTS (
        SELECT 1 FROM followup_assignment_lead fal
        INNER JOIN followup_assignment fa ON fa.id = fal.assignment_id
        WHERE fal.client_id = client.id
          AND fa.assignment_date = :assignmentDate
          AND fal.send_status IN ('pending', 'sent')
      )`,
      { assignmentDate }
    )
    .andWhere(
      `NOT EXISTS (
        SELECT 1 FROM incoming_message im
        WHERE im."emailAddress" = :mailboxExact
          AND im."deletedAt" IS NULL
          AND im."messageType" <> 'ignored_sender'
          AND im."messageType" <> 'hide_sender'
          AND COALESCE(im."receivedAt", im."createdAt") > "client"."lastSent"
          AND (
            LOWER(COALESCE(im."fromEmail", '')) LIKE ('%' || LOWER(TRIM("client"."email")) || '%')
            OR (
              im."messageType" IN ('blocked', 'ooo', 'bad', 'interest', 'no_job')
              AND (
                LOWER(COALESCE(im."fromEmail", '')) LIKE ('%' || LOWER(TRIM("client"."email")) || '%')
                OR LOWER(COALESCE(im."subject", '')) LIKE ('%' || LOWER(TRIM("client"."email")) || '%')
              )
            )
            OR (
              LOWER(COALESCE(im."fromEmail", '')) LIKE '%mailer-daemon%'
              AND LOWER(COALESCE(im."subject", '')) LIKE ('%' || LOWER(TRIM("client"."email")) || '%')
            )
            OR (
              LOWER(COALESCE(im."fromEmail", '')) LIKE '%postmaster%'
              AND LOWER(COALESCE(im."subject", '')) LIKE ('%' || LOWER(TRIM("client"."email")) || '%')
            )
            OR (
              im."messageType" = 'other'
              AND LOWER(COALESCE(im."fromEmail", '')) LIKE ('%' || LOWER(TRIM("client"."email")) || '%')
            )
            OR (
              im."messageType" = 'blocked'
              AND (
                LOWER(COALESCE(im."fromEmail", '')) LIKE '%mailer-daemon%'
                OR LOWER(COALESCE(im."fromEmail", '')) LIKE '%postmaster%'
                OR LOWER(COALESCE(im."fromEmail", '')) LIKE '%mail delivery%'
              )
            )
          )
      )`
    )
    .setParameter('mailboxExact', email.address);

  if (excludeClientIds.length) {
    qb.andWhere('client.id NOT IN (:...excludeClientIds)', { excludeClientIds });
  }

  qb
    .orderBy(
      `(
        CASE WHEN EXISTS (
          SELECT 1 FROM marketing_assignment_lead mal_prio
          INNER JOIN marketing_assignment ma_prio ON ma_prio.id = mal_prio.assignment_id
          WHERE mal_prio.client_id = client.id
            AND ma_prio.email_id = :emailId
            AND mal_prio.send_status = 'sent'
            AND mal_prio.nylas_message_id IS NOT NULL
            AND TRIM(mal_prio.nylas_message_id) <> ''
        ) THEN 0 ELSE 1 END
      )`,
      'ASC'
    )
    .addOrderBy('client.lastSent', 'ASC')
    .take(max);

  return qb.getMany();
}

export async function releaseAllOrphanedFollowupRuns(reason = 'server startup') {
  const repo = AppDataSource.getRepository(FollowupAssignment);
  const rows = await repo.find({ where: { running: true } });
  if (!rows.length) return 0;
  for (const row of rows) {
    row.running = false;
    if (row.status === 'running') row.status = 'assigned';
    row.lastError = row.lastError || `Send loop stopped (${reason}). Start follow-ups again to resume.`;
  }
  await repo.save(rows);
  followupLog(null, 'released orphaned running flags', { count: rows.length, reason });
  return rows.length;
}

export async function getFollowupDashboard(assignmentDate, options = {}) {
  const date = getAssignmentDateString(assignmentDate);
  const nylasOnly = options.nylasOnly !== false && options.nylasOnly !== 'false';

  const emailRepo = AppDataSource.getRepository(Email);
  let emailQb = emailRepo
    .createQueryBuilder('email')
    .leftJoinAndSelect('email.account', 'account')
    .where('email.deletedAt IS NULL');
  if (nylasOnly) {
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

  const nylasFollowupTodayByEmail = new Map();
  const followupTodayRows = await AppDataSource.getRepository(FollowupAssignmentLead)
    .createQueryBuilder('fal')
    .innerJoin('fal.assignment', 'fa')
    .select('fa.emailId', 'emailId')
    .addSelect('COUNT(*)', 'cnt')
    .where('fal.sendStatus = :sent', { sent: 'sent' })
    .andWhere('fal.sentAt >= :today', { today })
    .andWhere('fal.sentAt < :tomorrow', { tomorrow })
    .groupBy('fa.emailId')
    .getRawMany();
  for (const r of followupTodayRows) {
    nylasFollowupTodayByEmail.set(r.emailId, parseInt(String(r.cnt), 10) || 0);
  }

  const assignmentRepo = AppDataSource.getRepository(FollowupAssignment);
  const assignments = await assignmentRepo.find({ where: { assignmentDate: date } });
  const assignmentByEmail = new Map(assignments.map((a) => [a.emailId, a]));
  const statsMap = await getAssignmentStats(assignments.map((a) => a.id));

  const rows = emails.map((email) => {
    const nylas = getNylasCredentialsStatus(email);
    const assignment = assignmentByEmail.get(email.id) || null;
    const stats = assignment ? statsMap.get(assignment.id) : null;
    const counts = stats || { assigned: 0, pending: 0, sent: 0, failed: 0 };
    const baseline = assignment?.dailyLimitSentBaseline ?? 0;
    const effectiveSent = effectiveSentForDailyLimit(counts.sent, baseline);
    const followupDailyLimit = resolveDailyLimitFromEmail(email, 10);
    const followupEnabled = isFollowupEnabledForEmail(email);
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
      followupEnabled,
      marketingDailyLimit: email.marketingDailyLimit ?? null,
      emailStatus: email.status,
      nylasStatus: nylas.status,
      nylasDetail: nylas.detail,
      assignmentId: assignment?.id || null,
      daysBefore: assignment?.daysBefore ?? null,
      targetCount: assignment?.targetCount ?? 0,
      assignedCount: counts.assigned,
      pendingCount: counts.pending,
      sentCount: counts.sent,
      dailyLimitSentBaseline: baseline,
      effectiveSentCount: effectiveSent,
      dailyLimitRemaining: Math.max(0, followupDailyLimit - counts.pending - effectiveSent),
      followupDailyLimit,
      failedCount: counts.failed,
      running: Boolean(assignment?.running),
      canAssign: canAssignFollowupToEmail(email),
      canRun:
        canAssignFollowupToEmail(email) &&
        !followupOrchestratorActive &&
        !assignment?.running &&
        (counts.pending || 0) > 0,
      lastError: assignment?.lastError || null,
      messagesSentToday: todayStats.messagesSentToday,
      followupsSentToday: todayStats.followupsSentToday,
      nylasFollowupToday: nylasFollowupTodayByEmail.get(email.id) || 0,
    };
  });

  const sendDelay = getMarketingSendDelayConfig();
  return {
    assignmentDate: date,
    progressDate: today.toISOString().slice(0, 10),
    progressDateEnd: tomorrow.toISOString(),
    nylasOnly,
    assignAllActive: followupAssignAllActive,
    assignAllSummary: followupAssignAllSummary,
    rows,
    checkedAt: new Date().toISOString(),
    sendDelayMinMs: sendDelay.minMs,
    sendDelayMaxMs: sendDelay.maxMs,
    sendDelayMinMinutes: Math.round(sendDelay.minMs / 60000),
    sendDelayMaxMinutes: Math.round(sendDelay.maxMs / 60000),
  };
}

export async function setFollowupEnabled(emailId, enabled) {
  const emailRepo = AppDataSource.getRepository(Email);
  const email = await emailRepo.findOne({ where: { id: emailId, deletedAt: null } });
  if (!email) throw new Error('Email account not found');
  if (Boolean(enabled) && !hasNylasCredentials(email)) {
    throw new Error('Grant ID and Nylas API key are required before enabling follow-ups');
  }
  email.followupEnabled = Boolean(enabled);
  await emailRepo.save(email);
  return { emailId: email.id, address: email.address, followupEnabled: email.followupEnabled };
}

export async function assignFollowupsToEmail(emailId, count, assignmentDate, daysBefore) {
  const date = getAssignmentDateString(assignmentDate);
  const days = Math.min(365, Math.max(1, parseInt(String(daysBefore), 10) || 7));
  let requested = Math.min(500, Math.max(0, parseInt(String(count), 10) || 0));
  if (!requested) throw new Error('count must be at least 1');

  const emailRepo = AppDataSource.getRepository(Email);
  const email = await emailRepo.findOne({
    where: { id: emailId, deletedAt: null },
    relations: ['account'],
  });
  if (!email) throw new Error('Email account not found');
  if (!canAssignFollowupToEmail(email)) {
    throw new Error(
      !isFollowupEnabledForEmail(email)
        ? 'Follow-ups are disabled for this mailbox'
        : isEmailAccountBlocked(email)
          ? `Cannot assign with status "${email.status}"`
          : 'Grant ID and Nylas API key are required'
    );
  }

  const limitState = await getFollowupDailyLimitState(email, date);
  requested = Math.min(requested, limitState.remaining);
  if (!requested) {
    return {
      assigned: 0,
      skippedNoThread: 0,
      skippedWithReply: 0,
      message: 'Follow-up daily limit already reached (separate from cold outreach)',
    };
  }

  const candidatesProbe = await fetchFollowupCandidateClients(email, days, date, 1);
  if (!candidatesProbe.length) {
    return {
      assigned: 0,
      skippedNoThread: 0,
      skippedWithReply: 0,
      message: `No eligible leads (sent ≥${days} day(s) ago, no reply, not yet followed up)`,
    };
  }

  const assignment = await getOrCreateAssignment(email.id, date, days);
  const leadRepo = AppDataSource.getRepository(FollowupAssignmentLead);
  let assigned = 0;
  let skippedNoThread = 0;
  let skippedWithReply = 0;
  const triedClientIds = new Set();
  const MAX_POOL_SCAN = 500;

  while (assigned < requested && triedClientIds.size < MAX_POOL_SCAN) {
    const batchSize = Math.min(
      200,
      Math.max(50, (requested - assigned) * 8)
    );
    const batch = await fetchFollowupCandidateClients(email, days, date, {
      limit: batchSize,
      excludeClientIds: Array.from(triedClientIds),
    });
    if (!batch.length) break;

    const storedMap = await loadStoredMarketingNylasMessageMap(
      email.id,
      batch.map((c) => c.id)
    );

    for (const client of batch) {
      if (assigned >= requested) break;
      triedClientIds.add(client.id);

      const original = await resolveOriginalOutboundForFollowup({
        emailId: email.id,
        grantId: email.grantId,
        nylasKey: email.nylasKey,
        mailboxAddress: email.address,
        clientId: client.id,
        leadEmail: client.email,
        lastSent: client.lastSent,
        storedMessageMap: storedMap,
      });

      if (!original?.messageId) {
        skippedNoThread += 1;
        continue;
      }

      const eligibility = await leadIsEligibleForFollowup({
        mailboxAddress: email.address,
        leadEmail: client.email,
        lastSent: client.lastSent,
        grantId: email.grantId,
        nylasKey: email.nylasKey,
        originalMessageId: original.messageId,
        checkNylas: true,
      });
      if (!eligibility.eligible) {
        skippedWithReply += 1;
        continue;
      }

      await leadRepo.save(
        leadRepo.create({
          assignmentId: assignment.id,
          clientId: client.id,
          sendStatus: 'pending',
          replyToMessageId: original.messageId,
          originalSubject: original.subject,
        })
      );
      assigned += 1;
    }

    if (batch.length < batchSize) break;
  }

  assignment.targetCount = await syncAssignmentTargetCount(assignment.id);
  assignment.status = 'assigned';
  assignment.lastError = null;
  await AppDataSource.getRepository(FollowupAssignment).save(assignment);

  const parts = [];
  if (skippedNoThread > 0) parts.push(`${skippedNoThread} without original thread in Nylas`);
  if (skippedWithReply > 0) parts.push(`${skippedWithReply} with inbound reply (incl. bounces/blocks)`);

  return {
    assigned,
    skippedNoThread,
    skippedWithReply,
    assignmentId: assignment.id,
    daysBefore: days,
    message:
      parts.length > 0
        ? `Assigned ${assigned}; skipped: ${parts.join('; ')}.`
        : undefined,
  };
}

export async function assignFollowupsToAll(countPerAccount, assignmentDate, daysBefore, options = {}) {
  const date = getAssignmentDateString(assignmentDate);
  const days = Math.min(365, Math.max(1, parseInt(String(daysBefore), 10) || 7));
  const defaultCount = Math.max(1, Math.min(500, parseInt(String(countPerAccount), 10) || 10));
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const dashboard = await getFollowupDashboard(date);
  const eligible = dashboard.rows.filter((r) => r.followupEnabled && r.canAssign);
  const concurrency = Math.min(
    8,
    Math.max(1, parseInt(String(process.env.FOLLOWUP_ASSIGN_ALL_CONCURRENCY || '4'), 10) || 4)
  );

  let totalAssigned = 0;
  let totalSkippedNoThread = 0;
  let totalSkippedWithReply = 0;
  const accounts = new Array(eligible.length);
  let accountsDone = 0;

  onProgress?.({ accountsTotal: eligible.length, accountsDone: 0, totalAssigned: 0 });

  async function processRow(row, index) {
    const count = resolveAssignCount(row, defaultCount);
    if (count === 0) {
      accounts[index] = {
        emailId: row.emailId,
        address: row.address,
        assigned: 0,
        skippedNoThread: 0,
        skippedWithReply: 0,
        skipped: true,
        message: 'Daily limit already reached',
      };
      accountsDone += 1;
      onProgress?.({ accountsDone, totalAssigned, totalSkippedNoThread, totalSkippedWithReply });
      return;
    }
    try {
      const result = await assignFollowupsToEmail(row.emailId, count, date, days);
      totalAssigned += result.assigned || 0;
      totalSkippedNoThread += result.skippedNoThread || 0;
      totalSkippedWithReply += result.skippedWithReply || 0;
      accounts[index] = {
        emailId: row.emailId,
        address: row.address,
        assigned: result.assigned || 0,
        skippedNoThread: result.skippedNoThread || 0,
        skippedWithReply: result.skippedWithReply || 0,
      };
    } catch (err) {
      accounts[index] = {
        emailId: row.emailId,
        address: row.address,
        assigned: 0,
        error: err.message || String(err),
      };
    }
    accountsDone += 1;
    onProgress?.({ accountsDone, totalAssigned, totalSkippedNoThread, totalSkippedWithReply });
  }

  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= eligible.length) break;
      await processRow(eligible[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, eligible.length || 1) }, () => worker());
  await Promise.all(workers);

  return {
    totalAssigned,
    totalSkippedNoThread,
    totalSkippedWithReply,
    daysBefore: days,
    accounts,
  };
}

export function startAssignFollowupsToAll(countPerAccount, assignmentDate, daysBefore) {
  if (followupAssignAllActive) {
    throw new Error('Auto-assign is already in progress. Refresh to see updated counts.');
  }

  followupAssignAllActive = true;
  followupAssignAllSummary = {
    startedAt: new Date().toISOString(),
    accountsTotal: 0,
    accountsDone: 0,
    totalAssigned: 0,
    totalSkippedNoThread: 0,
    totalSkippedWithReply: 0,
  };

  void assignFollowupsToAll(countPerAccount, assignmentDate, daysBefore, {
    onProgress: (update) => {
      followupAssignAllSummary = {
        ...followupAssignAllSummary,
        ...update,
      };
    },
  })
    .then((result) => {
      const failed = (result.accounts || []).filter((a) => a.error);
      followupAssignAllSummary = {
        ...followupAssignAllSummary,
        finishedAt: new Date().toISOString(),
        totalAssigned: result.totalAssigned,
        totalSkippedNoThread: result.totalSkippedNoThread,
        totalSkippedWithReply: result.totalSkippedWithReply,
        accountsFailed: failed.length,
        error:
          failed.length && !result.totalAssigned
            ? failed[0].error || 'All mailboxes failed to assign'
            : followupAssignAllSummary?.error,
      };
      followupLog(null, 'assign-all finished', {
        totalAssigned: result.totalAssigned,
        accounts: result.accounts?.length ?? 0,
      });
    })
    .catch((err) => {
      followupAssignAllSummary = {
        ...followupAssignAllSummary,
        finishedAt: new Date().toISOString(),
        error: err.message || String(err),
      };
      followupLog(null, 'assign-all failed', { error: err.message });
    })
    .finally(() => {
      followupAssignAllActive = false;
    });

  return {
    started: true,
    message:
      'Assigning follow-ups in background. Assigned/Pending counts will update mailbox by mailbox — refresh or wait a few minutes.',
  };
}

async function markClientFollowedUp(client, mailboxAddress) {
  const clientRepo = AppDataSource.getRepository(Client);
  const currentSentBy = client.sentBy || [];
  const sentBy = currentSentBy.includes(mailboxAddress)
    ? currentSentBy
    : [...currentSentBy, mailboxAddress];
  await clientRepo.update(
    { id: client.id },
    {
      isFollowup: true,
      status: 'followedup',
      lastSent: new Date(),
      sentBy,
    }
  );
}

async function waitForMailboxSendSpacing(assignmentId, mailbox) {
  const leadRepo = AppDataSource.getRepository(FollowupAssignmentLead);
  const lastSent = await leadRepo.findOne({
    where: { assignmentId, sendStatus: 'sent' },
    order: { sentAt: 'DESC' },
  });
  if (!lastSent?.sentAt) return;

  const elapsed = Date.now() - new Date(lastSent.sentAt).getTime();
  const requiredMs = getRandomMarketingSendDelayMs();
  const waitMs = requiredMs - elapsed;
  if (waitMs > 0) {
    followupLog(mailbox, `waiting ${Math.round(waitMs / 1000)}s before next send`, {
      requiredSec: Math.round(requiredMs / 1000),
      elapsedSec: Math.round(elapsed / 1000),
    });
    await sleepUnlessFollowupStopped(waitMs);
  }
}

async function getNextPendingLead(assignmentId) {
  return AppDataSource.getRepository(FollowupAssignmentLead).findOne({
    where: { assignmentId, sendStatus: 'pending' },
    relations: ['client'],
    order: { createdAt: 'ASC' },
  });
}

async function countPendingLeads(assignmentId) {
  return AppDataSource.getRepository(FollowupAssignmentLead).count({
    where: { assignmentId, sendStatus: 'pending' },
  });
}

async function sendOneFollowupLead(email, assignment, leadRow, meta = {}) {
  const leadRepo = AppDataSource.getRepository(FollowupAssignmentLead);
  const mb = email.address;
  const client = leadRow.client;

  if (!client?.email) {
    leadRow.sendStatus = 'failed';
    leadRow.errorMessage = 'Lead has no email address';
    await leadRepo.save(leadRow);
    return { sent: 0, failed: 1 };
  }

  if (!leadRow.replyToMessageId) {
    leadRow.sendStatus = 'failed';
    leadRow.errorMessage = 'Missing reply_to_message_id (re-assign to resolve original thread)';
    await leadRepo.save(leadRow);
    return { sent: 0, failed: 1 };
  }

  const eligibility = await leadIsEligibleForFollowup({
    mailboxAddress: email.address,
    leadEmail: client.email,
    lastSent: client.lastSent,
    grantId: email.grantId,
    nylasKey: email.nylasKey,
    originalMessageId: leadRow.replyToMessageId,
    checkNylas: true,
  });
  if (!eligibility.eligible) {
    leadRow.sendStatus = 'failed';
    leadRow.errorMessage = `Skipped: thread has reply or delivery issue (${eligibility.reason})`;
    await leadRepo.save(leadRow);
    followupLog(mb, 'skipped — ineligible thread before send', {
      ...meta,
      reason: eligibility.reason,
      to: client.email,
    });
    return { sent: 0, failed: 1 };
  }

  try {
    const composed = await composeLeadOutboundEmail({
      lead: client,
      accountName: accountDisplayName(email),
      accountEmail: email.address,
      messageType: 'followup',
    });

    const threadSubject = String(leadRow.originalSubject || composed.subject || '').trim();
    const result = await sendNylasEmail({
      grantId: email.grantId,
      nylasKey: email.nylasKey,
      toEmail: client.email,
      toName: [client.firstName, client.lastName].filter(Boolean).join(' ') || client.email,
      subject: threadSubject || composed.subject,
      body: composed.body,
      replyToMessageId: leadRow.replyToMessageId,
    });

    if (!result.ok) {
      leadRow.sendStatus = 'failed';
      leadRow.errorMessage = result.error || 'Nylas send failed';
      leadRow.subject = threadSubject;
      leadRow.body = composed.body;
      await leadRepo.save(leadRow);
      return { sent: 0, failed: 1 };
    }

    leadRow.sendStatus = 'sent';
    leadRow.subject = threadSubject;
    leadRow.body = composed.body;
    leadRow.nylasMessageId = result.messageId || null;
    leadRow.sentAt = new Date();
    leadRow.errorMessage = null;
    await leadRepo.save(leadRow);
    await markClientFollowedUp(client, email.address);
    followupLog(mb, 'follow-up sent', { ...meta, nylasMessageId: result.messageId });
    return { sent: 1, failed: 0 };
  } catch (err) {
    leadRow.sendStatus = 'failed';
    leadRow.errorMessage = err.message || String(err);
    await leadRepo.save(leadRow);
    followupLog(mb, 'follow-up failed', { ...meta, error: err.message });
    return { sent: 0, failed: 1 };
  }
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function setAssignmentsRunning(assignmentIds, running) {
  if (!assignmentIds.length) return;
  const repo = AppDataSource.getRepository(FollowupAssignment);
  if (running) {
    await repo.update({ id: In(assignmentIds) }, { running: true, status: 'running' });
  } else {
    await repo.update({ id: In(assignmentIds) }, { running: false });
  }
}

async function finalizeFollowupWorkloads(workloads, { stopped = false } = {}) {
  const repo = AppDataSource.getRepository(FollowupAssignment);
  const leadRepo = AppDataSource.getRepository(FollowupAssignmentLead);
  const stopNote = 'Stopped by user. Pending follow-ups were not sent.';
  for (const w of workloads) {
    const pending = await countPendingLeads(w.assignment.id);
    const fresh = await repo.findOne({ where: { id: w.assignment.id } });
    if (!fresh) continue;
    fresh.running = false;
    if (pending === 0) {
      const failed = await leadRepo.count({
        where: { assignmentId: w.assignment.id, sendStatus: 'failed' },
      });
      const sent = await leadRepo.count({
        where: { assignmentId: w.assignment.id, sendStatus: 'sent' },
      });
      fresh.status = failed > 0 && sent === 0 ? 'failed' : sent > 0 ? 'completed' : 'assigned';
    } else {
      fresh.status = 'assigned';
      if (stopped) fresh.lastError = stopNote;
    }
    await repo.save(fresh);
  }
}

async function loadFollowupWorkloads(date, eligibleRows) {
  const emailRepo = AppDataSource.getRepository(Email);
  const assignmentRepo = AppDataSource.getRepository(FollowupAssignment);
  const workloads = [];

  for (const row of eligibleRows) {
    const email = await emailRepo.findOne({
      where: { id: row.emailId, deletedAt: null },
      relations: ['account'],
    });
    if (!email || !canAssignFollowupToEmail(email)) continue;

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
    });
  }
  return workloads;
}

async function processMailboxOneRound(workload, roundIndex, totalRounds) {
  if (isFollowupStopRequested()) return { sent: 0, failed: 0, skipped: true };

  const { email, assignment, address } = workload;
  const pending = await countPendingLeads(assignment.id);
  if (pending === 0) return { sent: 0, failed: 0, skipped: true };

  if (!(await followupCanSendAnother(email, assignment.assignmentDate))) {
    followupLog(address, 'daily follow-up limit reached — skipping send', { round: roundIndex + 1 });
    return { sent: 0, failed: 0, skipped: true, limitReached: true };
  }

  await waitForMailboxSendSpacing(assignment.id, address);
  if (isFollowupStopRequested()) return { sent: 0, failed: 0, skipped: true };
  const leadRow = await getNextPendingLead(assignment.id);
  if (!leadRow) return { sent: 0, failed: 0, skipped: true };

  return sendOneFollowupLead(email, assignment, leadRow, {
    round: roundIndex + 1,
    totalRounds,
    pendingBefore: pending,
  });
}

async function runFollowupRoundRobin(eligible, date, batchSize) {
  followupOrchestratorActive = true;
  let totalSent = 0;
  let totalFailed = 0;
  let workloads = [];

  try {
    workloads = await loadFollowupWorkloads(date, eligible);
    if (!workloads.length) return { totalSent, totalFailed };

    const maxRounds = Math.max(...workloads.map((w) => w.initialPending));
    for (let round = 0; round < maxRounds; round += 1) {
      if (isFollowupStopRequested()) break;
      const batches = chunkArray(workloads, batchSize);
      for (const batch of batches) {
        if (isFollowupStopRequested()) break;
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
    await finalizeFollowupWorkloads(workloads, { stopped: isFollowupStopRequested() });
    if (isFollowupStopRequested()) {
      followupLog(null, 'round-robin stopped by user', { totalSent, totalFailed });
    }
    return { totalSent, totalFailed };
  } finally {
    followupOrchestratorActive = false;
  }
}

export async function getFollowupAssignmentLeads(emailId, assignmentDate) {
  const date = getAssignmentDateString(assignmentDate);
  const email = await AppDataSource.getRepository(Email).findOne({
    where: { id: emailId, deletedAt: null },
  });
  if (!email) throw new Error('Email account not found');

  const assignment = await AppDataSource.getRepository(FollowupAssignment).findOne({
    where: { emailId, assignmentDate: date },
  });
  if (!assignment) {
    return { emailId, address: email.address, assignmentDate: date, assignmentId: null, leads: [] };
  }

  const rows = await AppDataSource.getRepository(FollowupAssignmentLead).find({
    where: { assignmentId: assignment.id },
    relations: ['client'],
    order: { createdAt: 'ASC' },
  });

  return {
    emailId,
    address: email.address,
    assignmentDate: date,
    assignmentId: assignment.id,
    daysBefore: assignment.daysBefore,
    leads: rows.map((row) => ({
      assignmentLeadId: row.id,
      clientId: row.clientId,
      sendStatus: row.sendStatus,
      email: row.client?.email || '',
      firstName: row.client?.firstName || '',
      lastName: row.client?.lastName || '',
      companyName: row.client?.companyName || '',
      replyToMessageId: row.replyToMessageId,
      originalSubject: row.originalSubject,
      canUnassign: row.sendStatus === 'pending',
    })),
  };
}

export async function unassignFollowupLead(assignmentLeadId) {
  const leadRepo = AppDataSource.getRepository(FollowupAssignmentLead);
  const row = await leadRepo.findOne({ where: { id: assignmentLeadId } });
  if (!row) throw new Error('Assigned lead not found');
  if (row.sendStatus !== 'pending') throw new Error('Only pending leads can be unassigned');

  const assignmentId = row.assignmentId;
  await leadRepo.remove(row);
  await syncAssignmentTargetCount(assignmentId);
  return { unassigned: true, assignmentLeadId };
}

export async function unassignAllPendingFollowupLeads({ assignmentDate, emailId } = {}) {
  const date = getAssignmentDateString(assignmentDate);
  const assignmentRepo = AppDataSource.getRepository(FollowupAssignment);
  const leadRepo = AppDataSource.getRepository(FollowupAssignmentLead);

  let assignmentIds = [];
  if (emailId) {
    const one = await assignmentRepo.findOne({ where: { emailId, assignmentDate: date } });
    if (one) assignmentIds = [one.id];
  } else {
    const all = await assignmentRepo.find({ where: { assignmentDate: date }, select: ['id'] });
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
    await unassignFollowupLead(row.id);
    unassigned += 1;
  }
  return { unassigned, assignmentDate: date, emailId: emailId || null };
}

export async function resetFollowupDailySentCount(assignmentDate, emailId = null) {
  const date = getAssignmentDateString(assignmentDate);
  const assignmentRepo = AppDataSource.getRepository(FollowupAssignment);
  const where = { assignmentDate: date };
  if (emailId) where.emailId = emailId;

  const assignments = await assignmentRepo.find({ where });
  if (!assignments.length) {
    return {
      assignmentDate: date,
      emailId: emailId || null,
      mailboxesReset: 0,
      message: 'No follow-up assignments found for this date',
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

  return {
    assignmentDate: date,
    emailId: emailId || null,
    mailboxesReset,
    message: `Daily follow-up sent count reset for ${mailboxesReset} mailbox(es).`,
  };
}

/**
 * Stop all in-flight follow-up sends for an assignment date (or every running assignment if date omitted).
 */
export async function stopAllFollowupRuns(assignmentDate) {
  followupStopRequested = true;
  const date = assignmentDate ? getAssignmentDateString(assignmentDate) : null;
  const repo = AppDataSource.getRepository(FollowupAssignment);
  const where = { running: true };
  if (date) where.assignmentDate = date;

  const rows = await repo.find({ where });
  const stopNote = 'Stopped by user. Pending follow-ups were not sent.';

  for (const row of rows) {
    row.running = false;
    if (row.status === 'running') row.status = 'assigned';
    const pending = await countPendingLeads(row.id);
    if (pending > 0) row.lastError = stopNote;
  }
  if (rows.length) await repo.save(rows);

  followupLog(null, 'stop-all requested', {
    assignmentDate: date,
    mailboxesCleared: rows.length,
    orchestratorWasActive: followupOrchestratorActive,
  });

  return {
    stopped: rows.length,
    assignmentDate: date,
    message:
      rows.length > 0
        ? `Stop requested. Cleared ${rows.length} running mailbox(es); pending follow-ups will not be sent.`
        : followupOrchestratorActive
          ? 'Stop requested. Follow-up send loop will end after the current step.'
          : 'No mailboxes were marked as running.',
  };
}

export async function runFollowupForEmail(emailId, assignmentDate) {
  const date = getAssignmentDateString(assignmentDate);
  if (!followupOrchestratorActive) clearFollowupStopRequest();

  const email = await AppDataSource.getRepository(Email).findOne({
    where: { id: emailId, deletedAt: null },
    relations: ['account'],
  });
  if (!email) throw new Error('Email account not found');
  if (followupOrchestratorActive) {
    throw new Error('Start-all is in progress. Wait or reset stuck sending.');
  }
  if (!canAssignFollowupToEmail(email)) {
    throw new Error('Mailbox is not eligible for follow-ups');
  }

  const assignmentRepo = AppDataSource.getRepository(FollowupAssignment);
  const assignment = await assignmentRepo.findOne({ where: { emailId, assignmentDate: date } });
  if (!assignment) throw new Error('No follow-ups assigned. Assign leads first.');

  const pendingCount = await countPendingLeads(assignment.id);
  if (!pendingCount) return { sent: 0, failed: 0, message: 'No pending follow-ups' };

  const claim = await assignmentRepo.update(
    { id: assignment.id, running: false },
    { running: true, status: 'running', lastError: null }
  );
  if (!claim.affected) throw new Error('Follow-ups already running for this mailbox');

  let sent = 0;
  let failed = 0;
  const mb = email.address;

  const stoppedByUser = () => isFollowupStopRequested();

  try {
    for (let i = 0; i < pendingCount; i += 1) {
      if (stoppedByUser()) break;
      if (!(await followupCanSendAnother(email, date))) {
        followupLog(mb, 'daily follow-up limit reached — stopping send loop');
        break;
      }
      await waitForMailboxSendSpacing(assignment.id, mb);
      if (stoppedByUser()) break;
      const row = await getNextPendingLead(assignment.id);
      if (!row) break;
      const result = await sendOneFollowupLead(email, assignment, row, { index: i + 1 });
      sent += result.sent;
      failed += result.failed;
    }
  } finally {
    const fresh = await assignmentRepo.findOne({ where: { id: assignment.id } });
    if (fresh) {
      fresh.running = false;
      const pendingLeft = await countPendingLeads(assignment.id);
      if (stoppedByUser() && pendingLeft > 0) {
        fresh.status = 'assigned';
        fresh.lastError = 'Stopped by user. Pending follow-ups were not sent.';
      } else {
        fresh.status = failed > 0 && sent === 0 ? 'failed' : sent > 0 ? 'completed' : 'assigned';
      }
      await assignmentRepo.save(fresh);
    }
  }

  return {
    sent,
    failed,
    total: pendingCount,
    stopped: stoppedByUser(),
  };
}

export async function runFollowupForAll(assignmentDate) {
  const date = getAssignmentDateString(assignmentDate);
  if (followupOrchestratorActive) {
    throw new Error('Follow-up send already in progress.');
  }

  clearFollowupStopRequest();

  const repo = AppDataSource.getRepository(FollowupAssignment);
  const running = await repo.find({ where: { assignmentDate: date, running: true } });
  for (const row of running) {
    row.running = false;
    if (row.status === 'running') row.status = 'assigned';
  }
  if (running.length) await repo.save(running);

  const dashboard = await getFollowupDashboard(date);
  const eligible = dashboard.rows.filter(
    (r) => r.followupEnabled && r.canAssign && (r.pendingCount || 0) > 0 && !r.running
  );
  const batchSize = getFollowupMaxParallelMailboxes();

  if (eligible.length > 0) {
    void runFollowupRoundRobin(eligible, date, batchSize).catch((err) => {
      followupLog(null, 'round-robin crashed', { error: err.message });
      followupOrchestratorActive = false;
    });
  }

  return {
    started: eligible.length,
    skipped: dashboard.rows.length - eligible.length,
    concurrency: batchSize,
    message:
      eligible.length > 0
        ? `Round-robin follow-ups started for ${eligible.length} mailbox(es). Replies use Nylas thread (reply_to_message_id).`
        : 'No mailboxes started. Assign follow-ups first.',
  };
}
