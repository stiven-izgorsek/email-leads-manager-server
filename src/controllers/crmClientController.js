import { AppDataSource } from '../config/database.js';
import { Brackets } from 'typeorm';
import { CrmClient, CRM_CLIENT_STATUSES } from '../entities/CrmClient.js';
import { Client } from '../entities/Client.js';
import { sanitizeAiMarkerInName, serializeClientLeadForApi } from '../utils/leadNameSanitize.js';
import { postFollowupReminderToSlack } from '../services/followupReminderSlackService.js';
import {
  markClientsLinkedToCrm,
  refreshClientCrmLinkFlag,
} from '../services/crmClientLeadLinkService.js';

function normalizeStatus(raw, fallback = 'first_connected') {
  const s = String(raw || fallback).toLowerCase().trim();
  return CRM_CLIENT_STATUSES.includes(s) ? s : fallback;
}

/** Dedupe valid CRM statuses while preserving first-seen order */
function dedupeValidStatuses(values) {
  const seen = new Set();
  const out = [];
  for (const raw of values || []) {
    const s = String(raw || '').toLowerCase().trim();
    if (CRM_CLIENT_STATUSES.includes(s) && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * Parse multi-status from body. Returns null when neither field was sent (PATCH semantics).
 */
function parseStatusesFromBody(body) {
  if (body.statuses !== undefined) {
    const raw = body.statuses;
    const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
    const cleaned = dedupeValidStatuses(list);
    return cleaned.length ? cleaned : ['first_connected'];
  }
  if (body.status !== undefined) {
    return [normalizeStatus(body.status)];
  }
  return null;
}

/** Effective statuses for a DB row (supports legacy rows with only varchar status). */
function getStatusesArray(row) {
  const parsed = row?.statuses;
  if (Array.isArray(parsed) && parsed.length) {
    const cleaned = dedupeValidStatuses(parsed);
    if (cleaned.length) return cleaned;
  }
  const legacy = row?.status && CRM_CLIENT_STATUSES.includes(row.status) ? row.status : null;
  return legacy ? [legacy] : ['first_connected'];
}

function applyStatusesToRow(row, statusesArray) {
  const arr = statusesArray?.length ? statusesArray : ['first_connected'];
  row.statuses = arr;
  row.status = arr[0];
}

function parseYyyyMmDd(raw) {
  const s = String(raw || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  const date = new Date(y, mo - 1, d, 0, 0, 0, 0);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== y ||
    date.getMonth() !== mo - 1 ||
    date.getDate() !== d
  ) {
    return null;
  }
  return date;
}

function toLocalYmd(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDate(raw) {
  if (raw == null || raw === '') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseRating(raw) {
  if (raw == null || raw === '') return null;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return null;
  if (n < 1) return 1;
  if (n > 10) return 10;
  return n;
}

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function nameFieldOrNull(v) {
  return sanitizeAiMarkerInName(trimOrNull(v));
}

function sentByAccountKey(raw) {
  return String(raw || '').trim().toLowerCase();
}

/** Same lead may have multiple CRM clients when sent-by mailbox differs. */
async function findCrmClientDuplicate(repo, { leadId, sentByAccount, excludeId }) {
  if (!leadId) return null;
  const qb = repo
    .createQueryBuilder('c')
    .where('c.leadId = :leadId', { leadId })
    .andWhere('c.deletedAt IS NULL')
    .andWhere("LOWER(TRIM(COALESCE(c.sentByAccount, ''))) = :sentKey", {
      sentKey: sentByAccountKey(sentByAccount),
    });
  if (excludeId) {
    qb.andWhere('c.id <> :excludeId', { excludeId });
  }
  return qb.getOne();
}

export function serializeCrmClient(row) {
  if (!row) return null;
  const statuses = getStatusesArray(row);
  return {
    id: row.id,
    leadId: row.leadId,
    email: row.email,
    firstName: sanitizeAiMarkerInName(row.firstName),
    lastName: sanitizeAiMarkerInName(row.lastName),
    country: row.country,
    companyName: sanitizeAiMarkerInName(row.companyName),
    jobTitle: row.jobTitle,
    linkedin: row.linkedin,
    connectedAt: row.connectedAt instanceof Date ? row.connectedAt.toISOString() : row.connectedAt,
    sentByAccount: row.sentByAccount,
    chatHistory: row.chatHistory,
    note: row.note,
    rating: row.rating,
    statuses,
    /** First tag — kept for older clients / extensions that still read `status` */
    status: statuses[0],
    followUpAt: row.followUpAt instanceof Date ? row.followUpAt.toISOString() : row.followUpAt,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

function applyFilters(qb, query) {
  const c = 'c';
  const search = (query.search || '').trim();
  if (search) {
    qb.andWhere(
      new Brackets((b) => {
        b.where(`${c}.email ILIKE :search`, { search: `%${search}%` })
          .orWhere(`${c}.firstName ILIKE :search`, { search: `%${search}%` })
          .orWhere(`${c}.lastName ILIKE :search`, { search: `%${search}%` })
          .orWhere(`${c}.companyName ILIKE :search`, { search: `%${search}%` });
      })
    );
  }

  const email = (query.email || '').trim();
  if (email) {
    qb.andWhere(`${c}.email ILIKE :emailFilter`, { emailFilter: `%${email}%` });
  }

  const country = (query.country || '').trim();
  if (country) {
    qb.andWhere(`${c}.country ILIKE :countryFilter`, { countryFilter: `%${country}%` });
  }

  const sentByAccount = (query.sentByAccount || '').trim();
  if (sentByAccount) {
    qb.andWhere(`${c}.sentByAccount ILIKE :sentByAccountFilter`, {
      sentByAccountFilter: `%${sentByAccount}%`,
    });
  }

  const status = (query.status || '').trim().toLowerCase();
  if (status && CRM_CLIENT_STATUSES.includes(status)) {
    const tag = JSON.stringify([status]);
    qb.andWhere(
      new Brackets((b) => {
        b.where(`COALESCE(${c}.statuses, '[]'::jsonb) @> CAST(:statusTag AS jsonb)`, {
          statusTag: tag,
        }).orWhere(`(${c}.statuses IS NULL AND ${c}.status = :legacyStatus)`, {
          legacyStatus: status,
        });
      }),
    );
  }

  const excludeFailedRaw = String(query.excludeFailed || '').toLowerCase();
  const excludeFailed =
    excludeFailedRaw === '1' || excludeFailedRaw === 'true' || excludeFailedRaw === 'yes';
  if (excludeFailed) {
    const failedTag = JSON.stringify(['failed']);
    qb.andWhere(
      `NOT (
        (COALESCE(${c}.statuses, '[]'::jsonb) @> CAST(:excludeFailedTag AS jsonb))
        OR (${c}.status = :excludeFailedLegacy)
      )`,
      { excludeFailedTag: failedTag, excludeFailedLegacy: 'failed' },
    );
  }

  const ratingMin = parseInt(query.ratingMin, 10);
  if (!Number.isNaN(ratingMin)) {
    qb.andWhere(`${c}.rating >= :ratingMin`, { ratingMin });
  }
  const ratingMax = parseInt(query.ratingMax, 10);
  if (!Number.isNaN(ratingMax)) {
    qb.andWhere(`${c}.rating <= :ratingMax`, { ratingMax });
  }

  // Filter clients whose followUpAt is on or after the given date (e.g. "due since")
  const followUpFrom = parseDate(query.followUpFrom);
  if (followUpFrom) {
    qb.andWhere(`${c}.followUpAt >= :fuFrom`, { fuFrom: followUpFrom });
  }
  // Filter clients whose followUpAt is on or before the given date (e.g. "due by")
  const followUpTo = parseDate(query.followUpTo);
  if (followUpTo) {
    // Make "to" inclusive of the whole day
    const end = new Date(followUpTo);
    end.setHours(23, 59, 59, 999);
    qb.andWhere(`${c}.followUpAt <= :fuTo`, { fuTo: end });
  }

  // followUpDay: shorthand for a specific calendar day (YYYY-MM-DD)
  const followUpDay = parseDate(query.followUpDay);
  if (followUpDay) {
    const dayStart = new Date(followUpDay);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(followUpDay);
    dayEnd.setHours(23, 59, 59, 999);
    qb.andWhere(`${c}.followUpAt >= :dayStart AND ${c}.followUpAt <= :dayEnd`, {
      dayStart,
      dayEnd,
    });
  }
}

/** Whitelist-only ORDER BY for CRM client list (prevents SQL injection). */
function applyCrmClientSort(qb, sortBy, sortOrder) {
  const o = sortOrder === 'ASC' ? 'ASC' : 'DESC';
  const nl = 'NULLS LAST';
  switch (sortBy) {
    case 'clientName':
      qb.orderBy('c.firstName', o, nl).addOrderBy('c.lastName', o, nl);
      break;
    case 'email':
      qb.orderBy('c.email', o, nl);
      break;
    case 'country':
      qb.orderBy('c.country', o, nl);
      break;
    case 'sentByAccount':
      qb.orderBy('c.sentByAccount', o, nl);
      break;
    case 'rating':
      qb.orderBy('c.rating', o, nl);
      break;
    case 'status':
      qb.orderBy('c.status', o, nl);
      break;
    case 'followUpAt':
      qb.orderBy('c.followUpAt', o, nl);
      break;
    case 'connectedAt':
      qb.orderBy('c.connectedAt', o, nl);
      break;
    case 'createdAt':
      qb.orderBy('c.createdAt', o, nl);
      break;
    case 'updatedAt':
    default:
      qb.orderBy('c.updatedAt', o, nl);
      break;
  }
}

export async function listCrmClients(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const sortByRaw = String(req.query.sortBy || 'updatedAt');
    const sortOrderRaw = String(req.query.sortOrder || 'DESC').toUpperCase();
    const sortOrder = sortOrderRaw === 'ASC' ? 'ASC' : 'DESC';

    const allowedSorts = new Set([
      'updatedAt',
      'createdAt',
      'clientName',
      'email',
      'country',
      'sentByAccount',
      'rating',
      'status',
      'followUpAt',
      'connectedAt',
    ]);
    const sortBy = allowedSorts.has(sortByRaw) ? sortByRaw : 'updatedAt';

    const repo = AppDataSource.getRepository(CrmClient);

    const qbCount = repo.createQueryBuilder('c').where('c.deletedAt IS NULL');
    applyFilters(qbCount, req.query);
    const total = await qbCount.getCount();

    const qb = repo.createQueryBuilder('c').where('c.deletedAt IS NULL');
    applyCrmClientSort(qb, sortBy, sortOrder);
    qb.skip(skip).take(limit);
    applyFilters(qb, req.query);
    const rows = await qb.getMany();

    const totalPages = Math.max(1, Math.ceil(total / limit));

    res.json({
      data: rows.map(serializeCrmClient),
      page,
      limit,
      total,
      totalPages,
    });
  } catch (error) {
    console.error('listCrmClients error:', error);
    res.status(500).json({ error: 'Failed to list clients' });
  }
}

export async function getFollowUpsToday(req, res) {
  try {
    const repo = AppDataSource.getRepository(CrmClient);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    // Include overdue (anything <= end of today) so users see what they
    // forgot to follow up on previous days as well.
    const includeOverdue = String(req.query.includeOverdue || 'true').toLowerCase() !== 'false';

    const qb = repo
      .createQueryBuilder('c')
      .where('c.deletedAt IS NULL')
      .andWhere('c.followUpAt IS NOT NULL');

    if (includeOverdue) {
      qb.andWhere('c.followUpAt <= :end', { end });
    } else {
      qb.andWhere('c.followUpAt >= :start AND c.followUpAt <= :end', { start, end });
    }

    qb.orderBy('c.followUpAt', 'ASC');

    const rows = await qb.getMany();
    res.json({ data: rows.map(serializeCrmClient) });
  } catch (error) {
    console.error('getFollowUpsToday error:', error);
    res.status(500).json({ error: 'Failed to load follow-ups' });
  }
}

export async function getCrmClient(req, res) {
  try {
    const repo = AppDataSource.getRepository(CrmClient);
    const row = await repo.findOne({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!row) return res.status(404).json({ error: 'Not found' });

    const serialized = serializeCrmClient(row);

    // Attach the linked lead snapshot if available
    let lead = null;
    if (row.leadId) {
      const leadRepo = AppDataSource.getRepository(Client);
      const leadRow = await leadRepo.findOne({
        where: { id: row.leadId, deletedAt: null },
      });
      if (leadRow) {
        lead = serializeClientLeadForApi({
          id: leadRow.id,
          email: leadRow.email,
          firstName: leadRow.firstName,
          lastName: leadRow.lastName,
          companyName: leadRow.companyName,
          companyUrl: leadRow.companyUrl,
          companyLocation: leadRow.companyLocation,
          location: leadRow.location,
          jobTitle: leadRow.jobTitle,
          linkedin: leadRow.linkedin,
          industries: leadRow.industries,
          tech: leadRow.tech,
          photoUrl: leadRow.photoUrl,
          status: leadRow.status,
        });
      }
    }

    res.json({ ...serialized, lead });
  } catch (error) {
    console.error('getCrmClient error:', error);
    res.status(500).json({ error: 'Failed to load client' });
  }
}

async function loadLeadSnapshot(leadId) {
  if (!leadId) return null;
  const leadRepo = AppDataSource.getRepository(Client);
  const lead = await leadRepo.findOne({
    where: { id: leadId, deletedAt: null },
  });
  return lead || null;
}

/**
 * Build a Lead (Client entity) record from the CRM-client form payload so that
 * users who add a client without picking an existing lead still get a proper
 * lead row created in the leads table.
 */
function buildLeadFromBody(body, email) {
  const sentByAccount = trimOrNull(body.sentByAccount);
  return {
    email,
    firstName: nameFieldOrNull(body.firstName),
    lastName: nameFieldOrNull(body.lastName),
    companyName: nameFieldOrNull(body.companyName),
    jobTitle: trimOrNull(body.jobTitle),
    linkedin: trimOrNull(body.linkedin),
    companyLocation: trimOrNull(body.country),
    location: trimOrNull(body.country),
    // Mirror sender info onto the lead so its history is consistent with the client.
    sentBy: sentByAccount ? [sentByAccount] : null,
    contactedBy: sentByAccount ? [sentByAccount] : null,
    lastSent: parseDate(body.connectedAt) || null,
    isSent: !!sentByAccount,
    // The client status enum is CRM-side; on the lead we just mark it as "client"
    // so the leads list can distinguish it from a fresh prospect.
    status: 'client',
    note: body.note != null ? String(body.note) : null,
  };
}

export async function createCrmClient(req, res) {
  try {
    const body = req.body || {};
    let leadId = trimOrNull(body.leadId);

    const leadRepo = AppDataSource.getRepository(Client);
    let snapshot = null;

    if (leadId) {
      snapshot = await loadLeadSnapshot(leadId);
      if (!snapshot) return res.status(400).json({ error: 'Linked lead not found' });
    }

    // Pull defaults from the lead snapshot, allow overrides via body.
    const email = trimOrNull(body.email) || snapshot?.email || null;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const repo = AppDataSource.getRepository(CrmClient);

    // No lead picked? Try to find an existing lead by email, otherwise create a
    // fresh one from the form data so every client is backed by a lead row.
    let createdNewLead = false;
    let reusedExistingLead = false;
    if (!leadId) {
      const existingLead = await leadRepo.findOne({
        where: { email, deletedAt: null },
      });
      if (existingLead) {
        snapshot = existingLead;
        leadId = existingLead.id;
        reusedExistingLead = true;
      } else {
        const newLead = leadRepo.create(buildLeadFromBody(body, email));
        const savedLead = await leadRepo.save(newLead);
        snapshot = savedLead;
        leadId = savedLead.id;
        createdNewLead = true;
      }
    }

    const sentByAccount = trimOrNull(body.sentByAccount);

    const dup = await findCrmClientDuplicate(repo, { leadId, sentByAccount });
    if (dup) {
      return res.status(409).json({
        error: 'A client already exists for this lead and sent-by account',
        existingId: dup.id,
      });
    }

    const country =
      trimOrNull(body.country) ||
      trimOrNull(snapshot?.companyLocation) ||
      trimOrNull(snapshot?.location) ||
      null;

    const row = repo.create({
      leadId,
      email,
      firstName: nameFieldOrNull(body.firstName) || nameFieldOrNull(snapshot?.firstName) || null,
      lastName: nameFieldOrNull(body.lastName) || nameFieldOrNull(snapshot?.lastName) || null,
      country,
      companyName: nameFieldOrNull(body.companyName) || nameFieldOrNull(snapshot?.companyName) || null,
      jobTitle: trimOrNull(body.jobTitle) || trimOrNull(snapshot?.jobTitle) || null,
      linkedin: trimOrNull(body.linkedin) || trimOrNull(snapshot?.linkedin) || null,
      connectedAt: parseDate(body.connectedAt) || new Date(),
      sentByAccount,
      chatHistory: body.chatHistory != null ? String(body.chatHistory) : null,
      note: body.note != null ? String(body.note) : null,
      rating: parseRating(body.rating),
      followUpAt: parseDate(body.followUpAt),
    });

    const parsedStatuses = parseStatusesFromBody(body);
    applyStatusesToRow(row, parsedStatuses || ['first_connected']);

    const saved = await repo.save(row);
    markClientsLinkedToCrm({ leadId: saved.leadId, email: saved.email }).catch((err) => {
      console.error('[crm-link] Failed marking lead in CRM:', err.message || err);
    });
    res.status(201).json({
      ...serializeCrmClient(saved),
      createdNewLead,
      reusedExistingLead,
    });
  } catch (error) {
    console.error('createCrmClient error:', error);
    res.status(500).json({ error: 'Failed to create client' });
  }
}

export async function updateCrmClient(req, res) {
  try {
    const body = req.body || {};
    const repo = AppDataSource.getRepository(CrmClient);
    const existing = await repo.findOne({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const priorLeadId = existing.leadId;
    const priorEmail = existing.email;

    if (body.leadId !== undefined) {
      existing.leadId = trimOrNull(body.leadId);
    }
    if (body.email !== undefined) {
      const email = trimOrNull(body.email);
      if (!email) return res.status(400).json({ error: 'email cannot be empty' });
      existing.email = email;
    }
    if (body.firstName !== undefined) existing.firstName = nameFieldOrNull(body.firstName);
    if (body.lastName !== undefined) existing.lastName = nameFieldOrNull(body.lastName);
    if (body.country !== undefined) existing.country = trimOrNull(body.country);
    if (body.companyName !== undefined) existing.companyName = nameFieldOrNull(body.companyName);
    if (body.jobTitle !== undefined) existing.jobTitle = trimOrNull(body.jobTitle);
    if (body.linkedin !== undefined) existing.linkedin = trimOrNull(body.linkedin);
    if (body.connectedAt !== undefined) existing.connectedAt = parseDate(body.connectedAt);
    if (body.sentByAccount !== undefined) existing.sentByAccount = trimOrNull(body.sentByAccount);
    if (body.chatHistory !== undefined) {
      existing.chatHistory = body.chatHistory == null ? null : String(body.chatHistory);
    }
    if (body.note !== undefined) {
      existing.note = body.note == null ? null : String(body.note);
    }
    if (body.rating !== undefined) existing.rating = parseRating(body.rating);
    if (body.statuses !== undefined || body.status !== undefined) {
      const next = parseStatusesFromBody(body);
      if (next) applyStatusesToRow(existing, next);
    }
    if (body.followUpAt !== undefined) existing.followUpAt = parseDate(body.followUpAt);

    const dup = await findCrmClientDuplicate(repo, {
      leadId: existing.leadId,
      sentByAccount: existing.sentByAccount,
      excludeId: existing.id,
    });
    if (dup) {
      return res.status(409).json({
        error: 'A client already exists for this lead and sent-by account',
        existingId: dup.id,
      });
    }

    const saved = await repo.save(existing);
    refreshClientCrmLinkFlag({ leadId: priorLeadId, email: priorEmail }).catch((err) => {
      console.error('[crm-link] Failed refreshing prior lead CRM flag:', err.message || err);
    });
    refreshClientCrmLinkFlag({ leadId: saved.leadId, email: saved.email }).catch((err) => {
      console.error('[crm-link] Failed refreshing lead CRM flag:', err.message || err);
    });
    res.json(serializeCrmClient(saved));
  } catch (error) {
    console.error('updateCrmClient error:', error);
    res.status(500).json({ error: 'Failed to update client' });
  }
}

export async function deleteCrmClient(req, res) {
  try {
    const repo = AppDataSource.getRepository(CrmClient);
    const row = await repo.findOne({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!row) return res.status(404).json({ error: 'Not found' });
    row.deletedAt = new Date();
    await repo.save(row);
    refreshClientCrmLinkFlag({ leadId: row.leadId, email: row.email }).catch((err) => {
      console.error('[crm-link] Failed refreshing lead CRM flag after delete:', err.message || err);
    });
    res.json({ message: 'Client deleted successfully' });
  } catch (error) {
    console.error('deleteCrmClient error:', error);
    res.status(500).json({ error: 'Failed to delete client' });
  }
}

export async function getFollowUpCountsByDay(req, res) {
  try {
    const from = parseYyyyMmDd(req.query.from);
    const to = parseYyyyMmDd(req.query.to);
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to are required as YYYY-MM-DD' });
    }
    if (to < from) {
      return res.status(400).json({ error: 'to must be on or after from' });
    }

    const fromStart = new Date(from);
    fromStart.setDate(fromStart.getDate() - 1);
    fromStart.setHours(0, 0, 0, 0);
    const toEnd = new Date(to);
    toEnd.setDate(toEnd.getDate() + 1);
    toEnd.setHours(23, 59, 59, 999);

    const repo = AppDataSource.getRepository(CrmClient);
    const qb = repo
      .createQueryBuilder('c')
      .where('c.deletedAt IS NULL')
      .andWhere('c.followUpAt IS NOT NULL')
      .andWhere('c.followUpAt >= :fromStart AND c.followUpAt <= :toEnd', { fromStart, toEnd });

    const excludeId = String(req.query.excludeId || '').trim();
    if (excludeId) {
      qb.andWhere('c.id <> :excludeId', { excludeId });
    }

    const rows = await qb.getMany();
    const wanted = new Set();
    for (let cursor = new Date(from); cursor <= to; cursor.setDate(cursor.getDate() + 1)) {
      wanted.add(toLocalYmd(cursor));
    }

    const counts = {};
    for (const day of wanted) counts[day] = 0;
    for (const row of rows) {
      const day = toLocalYmd(row.followUpAt);
      if (day && Object.prototype.hasOwnProperty.call(counts, day)) {
        counts[day] += 1;
      }
    }

    res.json({ data: counts, from: toLocalYmd(from), to: toLocalYmd(to) });
  } catch (error) {
    console.error('getFollowUpCountsByDay error:', error);
    res.status(500).json({ error: 'Failed to load follow-up counts' });
  }
}

export async function getCrmClientStatuses(req, res) {
  res.json({ data: CRM_CLIENT_STATUSES });
}

/** CRM clients per mailbox (`sentByAccount`), for incoming overview tables. */
export async function getCrmClientCountsBySentAccount(req, res) {
  try {
    const repo = AppDataSource.getRepository(CrmClient);
    const rows = await repo
      .createQueryBuilder('c')
      .select('LOWER(TRIM(c.sentByAccount))', 'sentByAccount')
      .addSelect('COUNT(*)', 'count')
      .where('c.deletedAt IS NULL')
      .andWhere('c.sentByAccount IS NOT NULL')
      .andWhere("TRIM(c.sentByAccount) <> ''")
      .groupBy('LOWER(TRIM(c.sentByAccount))')
      .getRawMany();

    const counts = {};
    for (const row of rows) {
      const key = String(row.sentByAccount || '').trim().toLowerCase();
      if (!key) continue;
      counts[key] = Number(row.count || 0);
    }

    res.json({ data: counts });
  } catch (error) {
    console.error('getCrmClientCountsBySentAccount error:', error);
    res.status(500).json({ error: 'Failed to load client counts' });
  }
}

export async function notifyFollowupReminderSlack(req, res) {
  try {
    const repo = AppDataSource.getRepository(CrmClient);
    const row = await repo.findOne({ where: { id: req.params.id, deletedAt: null } });
    if (!row) return res.status(404).json({ error: 'Client not found' });

    await postFollowupReminderToSlack(serializeCrmClient(row));
    res.json({ success: true });
  } catch (error) {
    console.error('notifyFollowupReminderSlack error:', error);
    const status = error.status || 500;
    res.status(status).json({ error: error.message || 'Failed to send Slack notification' });
  }
}
