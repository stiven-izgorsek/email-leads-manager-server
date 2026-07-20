import { In, IsNull } from 'typeorm';
import { AppDataSource } from '../config/database.js';
import { Client } from '../entities/Client.js';
import { serializeClientLeadForApi } from '../utils/leadNameSanitize.js';

/** Only CRM rows that are still new (NULL treated as legacy new). Excludes ready/sent/etc. */
const NEW_STATUS_WHERE = "(LOWER(TRIM(client.status)) = 'new' OR client.status IS NULL)";

const NOT_ALREADY_READY_WHERE = `LOWER(TRIM(COALESCE(client.status, ''))) NOT IN ('ready', 'sent', 'followedup', 'used')`;

const NOT_PENDING_MARKETING_ASSIGNMENT_WHERE = `NOT EXISTS (
  SELECT 1 FROM marketing_assignment_lead mal
  WHERE mal.client_id = client.id AND mal.send_status = 'pending'
)`;

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

/**
 * Same pool as gmail-extension GET /leads/uncontacted (Millions-verified good/risky by default).
 */
export function buildUncontactedLeadsQuery(clientRepo, options = {}) {
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

  const qb = clientRepo
    .createQueryBuilder('client')
    .where('client.deletedAt IS NULL')
    .andWhere('(client.isSent = false OR client.isSent IS NULL)')
    .andWhere(NEW_STATUS_WHERE)
    .andWhere(NOT_ALREADY_READY_WHERE)
    .andWhere(NOT_PENDING_MARKETING_ASSIGNMENT_WHERE)
    .andWhere(
      `NOT EXISTS (
        SELECT 1 FROM client claimed
        WHERE claimed."deletedAt" IS NULL
          AND LOWER(TRIM(claimed.email)) = LOWER(TRIM(client.email))
          AND LOWER(TRIM(claimed.status)) = 'ready'
          AND claimed.id <> client.id
      )`
    );

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
  const result = await clientRepo
    .createQueryBuilder()
    .update(Client)
    .set({ status: 'new' })
    .where('id IN (:...clientIds)', { clientIds })
      .andWhere("LOWER(TRIM(status)) = 'ready'")
      .andWhere('deletedAt IS NULL')
    .execute();
  return result.affected || 0;
}
