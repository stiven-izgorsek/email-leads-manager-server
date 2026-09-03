import { In, IsNull } from 'typeorm';
import { AppDataSource } from '../config/database.js';
import { Client } from '../entities/Client.js';
import { serializeClientLeadForApi } from '../utils/leadNameSanitize.js';
import { applyLeadPriorityCountryOrder } from '../utils/marketingLeadPriorityCountries.js';

/** Only CRM rows that are still new (NULL treated as legacy new). Excludes ready/sent/etc. */
const NEW_STATUS_WHERE = "(LOWER(TRIM(client.status)) = 'new' OR client.status IS NULL)";

const NOT_ALREADY_READY_WHERE = `LOWER(TRIM(COALESCE(client.status, ''))) NOT IN ('ready', 'sent', 'followedup', 'used')`;

const NOT_PENDING_MARKETING_ASSIGNMENT_WHERE = `NOT EXISTS (
  SELECT 1 FROM marketing_assignment_lead mal
  WHERE mal.client_id = client.id AND mal.send_status = 'pending'
)`;

const NOT_DUPLICATE_READY_EMAIL_WHERE = `NOT EXISTS (
  SELECT 1 FROM client claimed
  WHERE claimed."deletedAt" IS NULL
    AND LOWER(TRIM(claimed.email)) = LOWER(TRIM(client.email))
    AND LOWER(TRIM(claimed.status)) = 'ready'
    AND claimed.id <> client.id
)`;

const OOO_RECLAIM_STATUS_WHERE = `LOWER(TRIM(COALESCE(client.status, ''))) IN ('replied', 'sent', 'followedup')`;

/** Latest non-hidden inbound for this lead is an out-of-office / auto-reply (denormalized on client). */
const LAST_INBOUND_IS_OOO_WHERE = `LOWER(TRIM(COALESCE(client.last_inbound_message_type, ''))) = 'ooo'`;

/** Previously outreached leads marked used — reclaim for another send. */
const USED_RECLAIM_STATUS_WHERE = `LOWER(TRIM(COALESCE(client.status, ''))) = 'used'`;

/** Human replies must not be reclaimed (OOO uses a separate pool). */
const NOT_HUMAN_REPLIED_WHERE = `(client.isReplied = false OR client.isReplied IS NULL)`;

/** Leads already saved as CRM clients are excluded from reclaim pools (denormalized flag). */
const NOT_IN_CRM_CLIENT_WHERE = `(client.isInCrmClient = false OR client.isInCrmClient IS NULL)`;

async function claimClientsAsReady(clientRepo, clientIds, emails = []) {
  if (!clientIds?.length) return 0;

  let affected = 0;

  const byId = await clientRepo
    .createQueryBuilder()
    .update(Client)
    .set({ status: 'ready' })
    .where('id IN (:...clientIds)', { clientIds })
    .andWhere('deletedAt IS NULL')
    .andWhere("(LOWER(TRIM(status)) = 'new' OR status IS NULL)")
    .execute();
  affected += byId.affected || 0;

  const normalizedEmails = [...new Set(emails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  if (normalizedEmails.length) {
    const byEmail = await clientRepo
      .createQueryBuilder()
      .update(Client)
      .set({ status: 'ready' })
      .where('LOWER(TRIM(email)) IN (:...emails)', { emails: normalizedEmails })
      .andWhere('deletedAt IS NULL')
      .andWhere("(LOWER(TRIM(status)) = 'new' OR status IS NULL)")
      .execute();
    affected += byEmail.affected || 0;
  }

  return affected;
}

function applyLeadPoolFilters(qb, options = {}) {
  const {
    verifiedOnly = true,
    leadFilterId,
    leadFilterIds,
    leadFilterMode = 'include',
    location,
    industry,
    assignmentDate,
    excludeClientIds = [],
  } = options;

  if (verifiedOnly) {
    qb.andWhere('client.millionsStatus IN (:...millionsStatuses)', {
      millionsStatuses: ['good', 'risky'],
    });
  }

  const filterIds = Array.isArray(leadFilterIds)
    ? leadFilterIds.map((id) => String(id || '').trim()).filter(Boolean)
    : leadFilterId
      ? [String(leadFilterId).trim()].filter(Boolean)
      : [];

  if (filterIds.length > 0) {
    if (leadFilterMode === 'exclude') {
      qb.andWhere('(client.leadFilterId IS NULL OR client.leadFilterId NOT IN (:...leadFilterIds))', {
        leadFilterIds: filterIds,
      });
    } else {
      qb.andWhere('client.leadFilterId IN (:...leadFilterIds)', { leadFilterIds: filterIds });
    }
  }

  if (location) {
    qb.andWhere('(client.location ILIKE :location OR client.companyLocation ILIKE :location)', {
      location: `%${location}%`,
    });
  }

  const locations = Array.isArray(options.locations)
    ? options.locations.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  if (locations.length > 0) {
    const parts = [];
    const params = {};
    locations.forEach((loc, i) => {
      const key = `locKw${i}`;
      parts.push(`(client.location ILIKE :${key} OR client.companyLocation ILIKE :${key})`);
      params[key] = `%${loc}%`;
    });
    qb.andWhere(`(${parts.join(' OR ')})`, params);
  }

  if (industry) {
    qb.andWhere('client.industries LIKE :industry', { industry: `%${industry}%` });
  }

  if (assignmentDate) {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM marketing_assignment_lead mal
        INNER JOIN marketing_assignment ma ON ma.id = mal.assignment_id
        WHERE mal.client_id = client.id AND ma.assignment_date = :assignmentDate
      )`,
      { assignmentDate }
    );
  }

  if (excludeClientIds.length) {
    qb.andWhere('client.id NOT IN (:...excludeClientIds)', { excludeClientIds });
  }

  return qb;
}

/**
 * Same pool as gmail-extension GET /leads/uncontacted (Millions-verified good/risky by default).
 */
export function buildUncontactedLeadsQuery(clientRepo, options = {}) {
  const qb = clientRepo
    .createQueryBuilder('client')
    .where('client.deletedAt IS NULL')
    .andWhere('(client.isSent = false OR client.isSent IS NULL)')
    .andWhere(NEW_STATUS_WHERE)
    .andWhere(NOT_ALREADY_READY_WHERE)
    .andWhere(NOT_PENDING_MARKETING_ASSIGNMENT_WHERE)
    .andWhere(NOT_DUPLICATE_READY_EMAIL_WHERE);

  applyLeadPoolFilters(qb, options);

  return qb
    .orderBy('client.createdAt', 'DESC')
    .addOrderBy(
      `CASE 
        WHEN client.millionsStatus = 'good' THEN 1 
        WHEN client.millionsStatus = 'risky' THEN 2 
        ELSE 3 
      END`,
      'ASC'
    );
}

/**
 * Previously contacted leads whose latest inbound is only an OOO / automatic reply.
 */
export function buildOooRepliedLeadsQuery(clientRepo, options = {}) {
  const qb = clientRepo
    .createQueryBuilder('client')
    .where('client.deletedAt IS NULL')
    .andWhere('client.email IS NOT NULL')
    .andWhere("TRIM(client.email) <> ''")
    .andWhere(OOO_RECLAIM_STATUS_WHERE)
    .andWhere(LAST_INBOUND_IS_OOO_WHERE)
    .andWhere(NOT_IN_CRM_CLIENT_WHERE)
    .andWhere(NOT_PENDING_MARKETING_ASSIGNMENT_WHERE)
    .andWhere(NOT_DUPLICATE_READY_EMAIL_WHERE);

  applyLeadPoolFilters(qb, options);

  return qb
    .orderBy('client.createdAt', 'ASC')
    .addOrderBy(
      `CASE 
        WHEN client.millionsStatus = 'good' THEN 1 
        WHEN client.millionsStatus = 'risky' THEN 2 
        ELSE 3 
      END`,
      'ASC'
    );
}

/**
 * Previously used leads (status used, not human-replied, not in CRM) for re-outreach.
 */
export function buildUsedLeadsQuery(clientRepo, options = {}) {
  const qb = clientRepo
    .createQueryBuilder('client')
    .where('client.deletedAt IS NULL')
    .andWhere('client.email IS NOT NULL')
    .andWhere("TRIM(client.email) <> ''")
    .andWhere(USED_RECLAIM_STATUS_WHERE)
    .andWhere(NOT_HUMAN_REPLIED_WHERE)
    .andWhere(NOT_IN_CRM_CLIENT_WHERE)
    .andWhere(NOT_PENDING_MARKETING_ASSIGNMENT_WHERE)
    .andWhere(NOT_DUPLICATE_READY_EMAIL_WHERE);

  applyLeadPoolFilters(qb, options);

  const hasPriority = applyLeadPriorityCountryOrder(qb, options.priorityCountries, 'client');
  if (hasPriority) {
    qb.addOrderBy('client.createdAt', 'ASC').addOrderBy(
      `CASE 
        WHEN client.millionsStatus = 'good' THEN 1 
        WHEN client.millionsStatus = 'risky' THEN 2 
        ELSE 3 
      END`,
      'ASC'
    );
    return qb;
  }

  return qb
    .orderBy('client.createdAt', 'ASC')
    .addOrderBy(
      `CASE 
        WHEN client.millionsStatus = 'good' THEN 1 
        WHEN client.millionsStatus = 'risky' THEN 2 
        ELSE 3 
      END`,
      'ASC'
    );
}

/** Quick counts explaining why /uncontacted may return no rows. */
export async function getUncontactedPoolStats(options = {}) {
  const clientRepo = AppDataSource.getRepository(Client);
  const baseQb = clientRepo
    .createQueryBuilder('client')
    .where('client.deletedAt IS NULL')
    .andWhere('(client.isSent = false OR client.isSent IS NULL)')
    .andWhere(NEW_STATUS_WHERE);

  const newTotal = await baseQb.clone().getCount();

  const verifiedQb = baseQb.clone().andWhere('client.millionsStatus IN (:...millionsStatuses)', {
    millionsStatuses: ['good', 'risky'],
  });
  const newVerified = await verifiedQb.clone().getCount();

  const available = await buildUncontactedLeadsQuery(clientRepo, options).getCount();

  const blockedByPendingMarketing = await verifiedQb
    .clone()
    .andWhere(
      `EXISTS (
        SELECT 1 FROM marketing_assignment_lead mal
        WHERE mal.client_id = client.id AND mal.send_status = 'pending'
      )`
    )
    .getCount();

  return {
    newTotal,
    newVerifiedGoodOrRisky: newVerified,
    available,
    blockedByPendingMarketing,
  };
}

/** Count of previously contacted leads whose latest inbound is OOO (marketing reclaim pool). */
export async function getOooReclaimablePoolStats(options = {}) {
  const clientRepo = AppDataSource.getRepository(Client);
  const available = await buildOooRepliedLeadsQuery(clientRepo, options).getCount();
  return { available };
}

/** Count of used leads eligible for marketing reclaim. */
export async function getUsedReclaimablePoolStats(options = {}) {
  const clientRepo = AppDataSource.getRepository(Client);
  const available = await buildUsedLeadsQuery(clientRepo, options).getCount();
  return { available };
}

export async function fetchUncontactedVerifiedLeads(options = {}) {
  const count = Math.max(1, parseInt(String(options.count), 10) || 1);

  return AppDataSource.transaction(async (manager) => {
    const clientRepo = manager.getRepository(Client);
    const qb = buildUncontactedLeadsQuery(clientRepo, options);

    const candidates = await qb
      .setLock('pessimistic_partial_write')
      .take(count)
      .getMany();

    if (!candidates.length) return [];

    const ids = candidates.map((c) => c.id);
    const emails = candidates.map((c) => c.email);
    const affected = await claimClientsAsReady(clientRepo, ids, emails);

    if (affected < ids.length) {
      console.warn(
        `[fetchUncontactedVerifiedLeads] Claimed ${affected} row(s) for ${ids.length} selected lead(s)`
      );
    }

    const verified = await clientRepo.find({
      where: { id: In(ids), status: 'ready', deletedAt: IsNull() },
      select: ['id', 'email', 'firstName', 'lastName', 'companyName', 'millionsStatus', 'status'],
    });
    const verifiedIds = new Set(verified.map((c) => c.id));
    return candidates
      .filter((c) => verifiedIds.has(c.id))
      .map((c) => {
        const row = verified.find((v) => v.id === c.id);
        return serializeClientLeadForApi({ ...c, ...row, status: 'ready' });
      });
  });
}

async function claimOooClientsAsReady(clientRepo, clientIds) {
  if (!clientIds?.length) return 0;
  const result = await clientRepo
    .createQueryBuilder()
    .update(Client)
    .set({ status: 'ready', isReplied: false, updatedAt: new Date() })
    .where('id IN (:...clientIds)', { clientIds })
    .andWhere('deletedAt IS NULL')
    .andWhere("LOWER(TRIM(status)) IN ('replied', 'sent', 'followedup')")
    .execute();
  return result.affected || 0;
}

async function claimUsedClientsAsReady(clientRepo, clientIds) {
  if (!clientIds?.length) return 0;
  const result = await clientRepo
    .createQueryBuilder()
    .update(Client)
    .set({ status: 'ready', updatedAt: new Date() })
    .where('id IN (:...clientIds)', { clientIds })
    .andWhere('deletedAt IS NULL')
    .andWhere("LOWER(TRIM(status)) = 'used'")
    .andWhere('(isReplied = false OR isReplied IS NULL)')
    .execute();
  return result.affected || 0;
}

/**
 * Claim previously used leads (not replied, not in CRM) for another marketing send.
 */
export async function fetchUsedLeads(options = {}) {
  const count = Math.max(1, parseInt(String(options.count), 10) || 1);

  return AppDataSource.transaction(async (manager) => {
    const clientRepo = manager.getRepository(Client);
    const qb = buildUsedLeadsQuery(clientRepo, options);

    const candidates = await qb
      .setLock('pessimistic_partial_write')
      .take(count)
      .getMany();

    if (!candidates.length) return [];

    const ids = candidates.map((c) => c.id);
    const affected = await claimUsedClientsAsReady(clientRepo, ids);

    if (affected < ids.length) {
      console.warn(`[fetchUsedLeads] Claimed ${affected} row(s) for ${ids.length} selected lead(s)`);
    }

    const verified = await clientRepo.find({
      where: { id: In(ids), status: 'ready', deletedAt: IsNull() },
      select: ['id', 'email', 'firstName', 'lastName', 'companyName', 'millionsStatus', 'status'],
    });
    const verifiedIds = new Set(verified.map((c) => c.id));
    return candidates
      .filter((c) => verifiedIds.has(c.id))
      .map((c) => {
        const row = verified.find((v) => v.id === c.id);
        return serializeClientLeadForApi({ ...c, ...row, status: 'ready' });
      });
  });
}

/**
 * Claim previously sent leads whose latest inbound is only OOO, so they can be outreached again.
 */
export async function fetchOooRepliedLeads(options = {}) {
  const count = Math.max(1, parseInt(String(options.count), 10) || 1);

  return AppDataSource.transaction(async (manager) => {
    const clientRepo = manager.getRepository(Client);
    const qb = buildOooRepliedLeadsQuery(clientRepo, options);

    const candidates = await qb
      .setLock('pessimistic_partial_write')
      .take(count)
      .getMany();

    if (!candidates.length) return [];

    const ids = candidates.map((c) => c.id);
    const affected = await claimOooClientsAsReady(clientRepo, ids);

    if (affected < ids.length) {
      console.warn(
        `[fetchOooRepliedLeads] Claimed ${affected} row(s) for ${ids.length} selected lead(s)`
      );
    }

    const verified = await clientRepo.find({
      where: { id: In(ids), status: 'ready', deletedAt: IsNull() },
      select: ['id', 'email', 'firstName', 'lastName', 'companyName', 'millionsStatus', 'status'],
    });
    const verifiedIds = new Set(verified.map((c) => c.id));
    return candidates
      .filter((c) => verifiedIds.has(c.id))
      .map((c) => {
        const row = verified.find((v) => v.id === c.id);
        return serializeClientLeadForApi({ ...c, ...row, status: 'ready' });
      });
  });
}

export async function markLeadsReady(clientIds) {
  if (!clientIds?.length) return 0;
  const clientRepo = AppDataSource.getRepository(Client);
  const clients = await clientRepo.find({
    where: { id: In(clientIds), deletedAt: IsNull() },
    select: ['id', 'email'],
  });
  return claimClientsAsReady(
    clientRepo,
    clients.map((c) => c.id),
    clients.map((c) => c.email)
  );
}

export async function resetLeadsFromReady(clientIds) {
  if (!clientIds?.length) return 0;
  const clientRepo = AppDataSource.getRepository(Client);

  const restoredOoo = await clientRepo
    .createQueryBuilder()
    .update(Client)
    .set({ status: 'replied', isReplied: true, updatedAt: new Date() })
    .where('id IN (:...clientIds)', { clientIds })
    .andWhere("LOWER(TRIM(status)) = 'ready'")
    .andWhere('isSent = true')
    .andWhere('deletedAt IS NULL')
    .andWhere(
      `(LOWER(TRIM(COALESCE(last_inbound_message_type, ''))) = 'ooo' OR isReplied = true)`
    )
    .execute();

  const restoredUsed = await clientRepo
    .createQueryBuilder()
    .update(Client)
    .set({ status: 'used', updatedAt: new Date() })
    .where('id IN (:...clientIds)', { clientIds })
    .andWhere("LOWER(TRIM(status)) = 'ready'")
    .andWhere('isSent = true')
    .andWhere('(isReplied = false OR isReplied IS NULL)')
    .andWhere('deletedAt IS NULL')
    .andWhere(`LOWER(TRIM(COALESCE(last_inbound_message_type, ''))) <> 'ooo'`)
    .execute();

  const restoredNew = await clientRepo
    .createQueryBuilder()
    .update(Client)
    .set({ status: 'new' })
    .where('id IN (:...clientIds)', { clientIds })
    .andWhere("LOWER(TRIM(status)) = 'ready'")
    .andWhere('(isSent = false OR isSent IS NULL)')
    .andWhere('deletedAt IS NULL')
    .execute();

  return (restoredOoo.affected || 0) + (restoredUsed.affected || 0) + (restoredNew.affected || 0);
}
