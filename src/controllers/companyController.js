import { AppDataSource } from '../config/database.js';
import { Brackets } from 'typeorm';
import { Company, COMPANY_STATUSES } from '../entities/Company.js';

function normalizeStatus(raw) {
  const s = String(raw || 'new').toLowerCase().trim();
  return COMPANY_STATUSES.includes(s) ? s : 'new';
}

export function serializeCompany(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    legalName: row.legalName,
    domain: row.domain,
    apolloOrganizationId: row.apolloOrganizationId,
    websiteUrl: row.websiteUrl,
    email: row.email,
    phone: row.phone,
    industry: row.industry,
    employeeCount: row.employeeCount,
    annualRevenue: row.annualRevenue,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    stateRegion: row.stateRegion,
    country: row.country,
    postalCode: row.postalCode,
    linkedinUrl: row.linkedinUrl,
    twitterUrl: row.twitterUrl,
    description: row.description,
    notes: row.notes,
    status: row.status,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

function applyCompanyFilters(qb, query) {
  const c = 'c';
  const search = (query.search || '').trim();
  if (search) {
    qb.andWhere(
      new Brackets((b) => {
        b.where(`${c}.name ILIKE :search`, { search: `%${search}%` })
          .orWhere(`${c}.legalName ILIKE :search`, { search: `%${search}%` })
          .orWhere(`${c}.domain ILIKE :search`, { search: `%${search}%` })
          .orWhere(`${c}.industry ILIKE :search`, { search: `%${search}%` })
          .orWhere(`${c}.city ILIKE :search`, { search: `%${search}%` })
          .orWhere(`${c}.country ILIKE :search`, { search: `%${search}%` });
      })
    );
  }

  const status = (query.status || '').trim().toLowerCase();
  if (status && COMPANY_STATUSES.includes(status)) {
    qb.andWhere(`${c}.status = :status`, { status });
  }
}

function csvEscape(val) {
  const s = val == null ? '' : String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const CSV_HEADER = [
  'id',
  'name',
  'legal_name',
  'domain',
  'apollo_organization_id',
  'website_url',
  'email',
  'phone',
  'industry',
  'employee_count',
  'annual_revenue',
  'address_line_1',
  'address_line_2',
  'city',
  'state_region',
  'country',
  'postal_code',
  'linkedin_url',
  'twitter_url',
  'status',
  'created_at',
  'updated_at',
];

export async function getCompanies(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const repo = AppDataSource.getRepository(Company);

    const qbCount = repo.createQueryBuilder('c').where('c.deletedAt IS NULL');
    applyCompanyFilters(qbCount, req.query);
    const total = await qbCount.getCount();

    const qb = repo
      .createQueryBuilder('c')
      .where('c.deletedAt IS NULL')
      .orderBy('c.updatedAt', 'DESC')
      .skip(skip)
      .take(limit);
    applyCompanyFilters(qb, req.query);
    const rows = await qb.getMany();

    const totalPages = Math.max(1, Math.ceil(total / limit));

    res.json({
      data: rows.map(serializeCompany),
      page,
      limit,
      total,
      totalPages,
    });
  } catch (error) {
    console.error('getCompanies error:', error);
    res.status(500).json({ error: 'Failed to list companies' });
  }
}

export async function exportCompaniesCsv(req, res) {
  try {
    const repo = AppDataSource.getRepository(Company);
    const qb = repo
      .createQueryBuilder('c')
      .where('c.deletedAt IS NULL')
      .orderBy('c.updatedAt', 'DESC');
    applyCompanyFilters(qb, req.query);
    const rows = await qb.getMany();

    const lines = [CSV_HEADER.join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.id,
          row.name,
          row.legalName,
          row.domain,
          row.apolloOrganizationId,
          row.websiteUrl,
          row.email,
          row.phone,
          row.industry,
          row.employeeCount,
          row.annualRevenue,
          row.addressLine1,
          row.addressLine2,
          row.city,
          row.stateRegion,
          row.country,
          row.postalCode,
          row.linkedinUrl,
          row.twitterUrl,
          row.status,
          row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
          row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
        ]
          .map(csvEscape)
          .join(',')
      );
    }

    const csv = lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="companies.csv"');
    res.send(csv);
  } catch (error) {
    console.error('exportCompaniesCsv error:', error);
    res.status(500).json({ error: 'Failed to export companies' });
  }
}

export async function getCompany(req, res) {
  try {
    const repo = AppDataSource.getRepository(Company);
    const row = await repo.findOne({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(serializeCompany(row));
  } catch (error) {
    console.error('getCompany error:', error);
    res.status(500).json({ error: 'Failed to load company' });
  }
}

export async function createCompany(req, res) {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const repo = AppDataSource.getRepository(Company);
    const row = repo.create({
      name,
      legalName: body.legalName != null ? String(body.legalName).trim() || null : null,
      domain: body.domain != null ? String(body.domain).trim() || null : null,
      websiteUrl: body.websiteUrl != null ? String(body.websiteUrl).trim() || null : null,
      email: body.email != null ? String(body.email).trim() || null : null,
      phone: body.phone != null ? String(body.phone).trim() || null : null,
      industry: body.industry != null ? String(body.industry).trim() || null : null,
      employeeCount: body.employeeCount != null ? String(body.employeeCount).trim() || null : null,
      annualRevenue: body.annualRevenue != null ? String(body.annualRevenue).trim() || null : null,
      addressLine1: body.addressLine1 != null ? String(body.addressLine1).trim() || null : null,
      addressLine2: body.addressLine2 != null ? String(body.addressLine2).trim() || null : null,
      city: body.city != null ? String(body.city).trim() || null : null,
      stateRegion: body.stateRegion != null ? String(body.stateRegion).trim() || null : null,
      country: body.country != null ? String(body.country).trim() || null : null,
      postalCode: body.postalCode != null ? String(body.postalCode).trim() || null : null,
      linkedinUrl: body.linkedinUrl != null ? String(body.linkedinUrl).trim() || null : null,
      twitterUrl: body.twitterUrl != null ? String(body.twitterUrl).trim() || null : null,
      description: body.description != null ? String(body.description).trim() || null : null,
      notes: body.notes != null ? String(body.notes).trim() || null : null,
      status: normalizeStatus(body.status),
    });

    const saved = await repo.save(row);
    res.status(201).json(serializeCompany(saved));
  } catch (error) {
    console.error('createCompany error:', error);
    res.status(500).json({ error: 'Failed to create company' });
  }
}

export async function updateCompany(req, res) {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const repo = AppDataSource.getRepository(Company);
    const existing = await repo.findOne({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    existing.name = name;
    existing.legalName = body.legalName != null ? String(body.legalName).trim() || null : null;
    existing.domain = body.domain != null ? String(body.domain).trim() || null : null;
    existing.websiteUrl = body.websiteUrl != null ? String(body.websiteUrl).trim() || null : null;
    existing.email = body.email != null ? String(body.email).trim() || null : null;
    existing.phone = body.phone != null ? String(body.phone).trim() || null : null;
    existing.industry = body.industry != null ? String(body.industry).trim() || null : null;
    existing.employeeCount = body.employeeCount != null ? String(body.employeeCount).trim() || null : null;
    existing.annualRevenue = body.annualRevenue != null ? String(body.annualRevenue).trim() || null : null;
    existing.addressLine1 = body.addressLine1 != null ? String(body.addressLine1).trim() || null : null;
    existing.addressLine2 = body.addressLine2 != null ? String(body.addressLine2).trim() || null : null;
    existing.city = body.city != null ? String(body.city).trim() || null : null;
    existing.stateRegion = body.stateRegion != null ? String(body.stateRegion).trim() || null : null;
    existing.country = body.country != null ? String(body.country).trim() || null : null;
    existing.postalCode = body.postalCode != null ? String(body.postalCode).trim() || null : null;
    existing.linkedinUrl = body.linkedinUrl != null ? String(body.linkedinUrl).trim() || null : null;
    existing.twitterUrl = body.twitterUrl != null ? String(body.twitterUrl).trim() || null : null;
    existing.description = body.description != null ? String(body.description).trim() || null : null;
    existing.notes = body.notes != null ? String(body.notes).trim() || null : null;
    existing.status = normalizeStatus(body.status);

    const saved = await repo.save(existing);
    res.json(serializeCompany(saved));
  } catch (error) {
    console.error('updateCompany error:', error);
    res.status(500).json({ error: 'Failed to update company' });
  }
}

export async function deleteCompany(req, res) {
  try {
    const repo = AppDataSource.getRepository(Company);
    const row = await repo.findOne({
      where: { id: req.params.id, deletedAt: null },
    });
    if (!row) return res.status(404).json({ error: 'Not found' });

    row.deletedAt = new Date();
    await repo.save(row);
    res.json({ message: 'Company deleted successfully' });
  } catch (error) {
    console.error('deleteCompany error:', error);
    res.status(500).json({ error: 'Failed to delete company' });
  }
}

const BULK_MAX_IDS = 500;

export async function bulkUpdateCompanyStatus(req, res) {
  try {
    const body = req.body || {};
    const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x).trim()).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids array is required' });
    const status = normalizeStatus(body.status);

    const repo = AppDataSource.getRepository(Company);
    const limited = [...new Set(ids)].slice(0, BULK_MAX_IDS);

    const result = await repo
      .createQueryBuilder()
      .update(Company)
      .set({ status, updatedAt: new Date() })
      .where('id IN (:...ids)', { ids: limited })
      .andWhere('deletedAt IS NULL')
      .execute();

    res.json({ updated: result.affected ?? 0 });
  } catch (error) {
    console.error('bulkUpdateCompanyStatus error:', error);
    res.status(500).json({ error: 'Failed to update companies' });
  }
}

export async function bulkSoftDeleteCompanies(req, res) {
  try {
    const body = req.body || {};
    const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x).trim()).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids array is required' });

    const repo = AppDataSource.getRepository(Company);
    const limited = [...new Set(ids)].slice(0, BULK_MAX_IDS);
    const now = new Date();

    const result = await repo
      .createQueryBuilder()
      .update(Company)
      .set({ deletedAt: now, updatedAt: now })
      .where('id IN (:...ids)', { ids: limited })
      .andWhere('deletedAt IS NULL')
      .execute();

    res.json({ deleted: result.affected ?? 0 });
  } catch (error) {
    console.error('bulkSoftDeleteCompanies error:', error);
    res.status(500).json({ error: 'Failed to delete companies' });
  }
}
