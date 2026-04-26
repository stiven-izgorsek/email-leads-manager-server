import { AppDataSource } from '../config/database.js';
import { Brackets } from 'typeorm';
import { CrmClient, CRM_CLIENT_STATUSES } from '../entities/CrmClient.js';
import { Client } from '../entities/Client.js';

function normalizeStatus(raw, fallback = 'first_connected') {
  const s = String(raw || fallback).toLowerCase().trim();
  return CRM_CLIENT_STATUSES.includes(s) ? s : fallback;
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

export function serializeCrmClient(row) {
  if (!row) return null;
  return {
    id: row.id,
    leadId: row.leadId,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    country: row.country,
    companyName: row.companyName,
    jobTitle: row.jobTitle,
    linkedin: row.linkedin,
    connectedAt: row.connectedAt instanceof Date ? row.connectedAt.toISOString() : row.connectedAt,
    sentByAccount: row.sentByAccount,
    chatHistory: row.chatHistory,
    note: row.note,
    rating: row.rating,
    status: row.status,
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

  const status = (query.status || '').trim().toLowerCase();
  if (status && CRM_CLIENT_STATUSES.includes(status)) {
    qb.andWhere(`${c}.status = :status`, { status });
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

export async function listCrmClients(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const sortByRaw = String(req.query.sortBy || 'updatedAt');
    const sortOrderRaw = String(req.query.sortOrder || 'DESC').toUpperCase();
    const allowedSorts = new Set([
      'updatedAt',
      'createdAt',
      'rating',
      'status',
      'email',
      'followUpAt',
      'connectedAt',
    ]);
    const sortBy = allowedSorts.has(sortByRaw) ? sortByRaw : 'updatedAt';
    const sortOrder = sortOrderRaw === 'ASC' ? 'ASC' : 'DESC';

    const repo = AppDataSource.getRepository(CrmClient);

    const qbCount = repo.createQueryBuilder('c').where('c.deletedAt IS NULL');
    applyFilters(qbCount, req.query);
    const total = await qbCount.getCount();

    const qb = repo
      .createQueryBuilder('c')
      .where('c.deletedAt IS NULL')
      .orderBy(`c.${sortBy}`, sortOrder, 'NULLS LAST')
      .skip(skip)
      .take(limit);
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
        lead = {
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
        };
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
    firstName: trimOrNull(body.firstName),
    lastName: trimOrNull(body.lastName),
    companyName: trimOrNull(body.companyName),
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

    // Prevent duplicate CRM client for the same lead.
    const dup = await repo.findOne({ where: { leadId, deletedAt: null } });
    if (dup) {
      return res.status(409).json({
        error: 'A client already exists for this lead',
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
      firstName: trimOrNull(body.firstName) || trimOrNull(snapshot?.firstName) || null,
      lastName: trimOrNull(body.lastName) || trimOrNull(snapshot?.lastName) || null,
      country,
      companyName: trimOrNull(body.companyName) || trimOrNull(snapshot?.companyName) || null,
      jobTitle: trimOrNull(body.jobTitle) || trimOrNull(snapshot?.jobTitle) || null,
      linkedin: trimOrNull(body.linkedin) || trimOrNull(snapshot?.linkedin) || null,
      connectedAt: parseDate(body.connectedAt) || new Date(),
      sentByAccount: trimOrNull(body.sentByAccount),
      chatHistory: body.chatHistory != null ? String(body.chatHistory) : null,
      note: body.note != null ? String(body.note) : null,
      rating: parseRating(body.rating),
      status: normalizeStatus(body.status),
      followUpAt: parseDate(body.followUpAt),
    });

    const saved = await repo.save(row);
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

    if (body.leadId !== undefined) {
      existing.leadId = trimOrNull(body.leadId);
    }
    if (body.email !== undefined) {
      const email = trimOrNull(body.email);
      if (!email) return res.status(400).json({ error: 'email cannot be empty' });
      existing.email = email;
    }
    if (body.firstName !== undefined) existing.firstName = trimOrNull(body.firstName);
    if (body.lastName !== undefined) existing.lastName = trimOrNull(body.lastName);
    if (body.country !== undefined) existing.country = trimOrNull(body.country);
    if (body.companyName !== undefined) existing.companyName = trimOrNull(body.companyName);
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
    if (body.status !== undefined) existing.status = normalizeStatus(body.status, existing.status);
    if (body.followUpAt !== undefined) existing.followUpAt = parseDate(body.followUpAt);

    const saved = await repo.save(existing);
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
    res.json({ message: 'Client deleted successfully' });
  } catch (error) {
    console.error('deleteCrmClient error:', error);
    res.status(500).json({ error: 'Failed to delete client' });
  }
}

export async function getCrmClientStatuses(req, res) {
  res.json({ data: CRM_CLIENT_STATUSES });
}
