import { AppDataSource } from '../config/database.js';
import { Company, COMPANY_STATUSES } from '../entities/Company.js';
import { CompanySavedSearch } from '../entities/CompanySavedSearch.js';
import {
  postApolloOrganizationSearch,
  getApolloApiKey,
} from '../services/apolloOrganizationService.js';

const MAX_EXTRACT_PAGES = 500;
const DEFAULT_MIN_FOUNDED_YEAR = 1950;

function normalizeStatus(raw) {
  const s = String(raw || 'pending').toLowerCase().trim();
  return COMPANY_STATUSES.includes(s) ? s : 'pending';
}

function csvEscape(val) {
  const s = val == null ? '' : String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function apolloOrgToCsvRow(org) {
  const phone =
    org.phone ||
    (org.primary_phone && (org.primary_phone.sanitized_number || org.primary_phone.number)) ||
    '';
  return [
    org.id,
    org.name,
    org.primary_domain,
    org.website_url,
    phone,
    org.linkedin_url,
    org.twitter_url,
    org.facebook_url,
    org.founded_year,
    org.alexa_ranking,
  ].map(csvEscape);
}

const CSV_HEADER = [
  'apollo_id',
  'name',
  'primary_domain',
  'website_url',
  'phone',
  'linkedin_url',
  'twitter_url',
  'facebook_url',
  'founded_year',
  'alexa_ranking',
];

function filtersNonEmpty(filters) {
  return filters && typeof filters === 'object' && Object.keys(filters).length > 0;
}

/**
 * Parse minimum founded year from extract request body (default 1950).
 * @param {object} body
 * @returns {number}
 */
function parseMinFoundedYear(body) {
  const raw = body?.min_founded_year ?? body?.minFoundedYear ?? DEFAULT_MIN_FOUNDED_YEAR;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n)) return DEFAULT_MIN_FOUNDED_YEAR;
  if (n < 1000) return 1000;
  if (n > 2100) return 2100;
  return n;
}

/**
 * Include org if founded_year >= minYear (inclusive).
 * Missing / invalid founded_year passes only when minYear <= DEFAULT_MIN_FOUNDED_YEAR (default baseline).
 * Stricter thresholds (e.g. 2025) require a known year from Apollo.
 * @param {object} org
 * @param {number} minYear
 */
function passesMinFoundedYear(org, minYear) {
  const raw = org?.founded_year;
  if (raw == null || raw === '') {
    return minYear <= DEFAULT_MIN_FOUNDED_YEAR;
  }
  const n = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n)) {
    return minYear <= DEFAULT_MIN_FOUNDED_YEAR;
  }
  return n >= minYear;
}

function filterOrganizationsByFoundedYear(organizations, minYear) {
  return organizations.filter((org) => passesMinFoundedYear(org, minYear));
}

export async function apolloSearch(req, res) {
  try {
    if (!getApolloApiKey()) {
      return res.status(503).json({ error: 'Apollo API is not configured (set APOLLO_API_KEY).' });
    }
    const body = req.body || {};
    const filters = body.filters || {};
    if (!filtersNonEmpty(filters)) {
      return res.status(400).json({ error: 'Add at least one Apollo filter before searching.' });
    }
    const page = Math.max(1, parseInt(body.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(body.per_page ?? body.perPage, 10) || 25));

    const result = await postApolloOrganizationSearch(filters, page, perPage);
    if (!result.ok) {
      return res.status(result.status >= 400 ? result.status : 502).json({
        error: result.text || 'Apollo search failed',
        details: result.json,
      });
    }

    const j = result.json || {};
    res.json({
      organizations: j.organizations || [],
      pagination: j.pagination || null,
      breadcrumbs: j.breadcrumbs || [],
      partial_results_only: j.partial_results_only,
      model_ids: j.model_ids || [],
    });
  } catch (error) {
    console.error('apolloSearch error:', error);
    res.status(500).json({ error: 'Apollo search failed' });
  }
}

async function fetchAllOrganizationsForFilters(filters, maxPages = MAX_EXTRACT_PAGES) {
  const all = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= maxPages) {
    const result = await postApolloOrganizationSearch(filters, page, 100);
    if (!result.ok) {
      const err = new Error(result.text || 'Apollo request failed');
      err.status = result.status;
      err.details = result.json;
      throw err;
    }
    const j = result.json || {};
    const orgs = j.organizations || [];
    all.push(...orgs);
    const pag = j.pagination || {};
    totalPages = Math.max(1, parseInt(pag.total_pages, 10) || 1);
    if (orgs.length === 0) break;
    page += 1;
  }

  return all;
}

export async function apolloExtractCsv(req, res) {
  try {
    if (!getApolloApiKey()) {
      return res.status(503).json({ error: 'Apollo API is not configured (set APOLLO_API_KEY).' });
    }
    const body = req.body || {};
    const filters = body.filters || {};
    if (!filtersNonEmpty(filters)) {
      return res.status(400).json({ error: 'Add at least one Apollo filter before extracting.' });
    }
    const maxPages = Math.min(MAX_EXTRACT_PAGES, Math.max(1, parseInt(body.max_pages, 10) || MAX_EXTRACT_PAGES));

    const minFoundedYear = parseMinFoundedYear(body);

    let organizations;
    try {
      organizations = await fetchAllOrganizationsForFilters(filters, maxPages);
    } catch (e) {
      console.error('apolloExtractCsv fetch error:', e);
      return res.status(e.status || 502).json({
        error: e.message || 'Failed to fetch all pages from Apollo',
        details: e.details,
      });
    }

    const totalFetchedFromApollo = organizations.length;
    organizations = filterOrganizationsByFoundedYear(organizations, minFoundedYear);

    const lines = [CSV_HEADER.join(',')];
    for (const org of organizations) {
      lines.push(apolloOrgToCsvRow(org).join(','));
    }

    const csv = lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="apollo-organizations-founded-ge-${minFoundedYear}.csv"`
    );
    res.setHeader('X-Apollo-Total-Fetched', String(totalFetchedFromApollo));
    res.setHeader('X-Apollo-Total-After-Founded-Year', String(organizations.length));
    res.setHeader('X-Apollo-Min-Founded-Year', String(minFoundedYear));
    res.send(csv);
  } catch (error) {
    console.error('apolloExtractCsv error:', error);
    res.status(500).json({ error: 'Failed to build CSV' });
  }
}

function mapApolloOrgToCompany(org, status) {
  const phone =
    org.phone ||
    (org.primary_phone && (org.primary_phone.sanitized_number || org.primary_phone.number)) ||
    null;
  const domain = org.primary_domain ? String(org.primary_domain).trim() || null : null;
  let websiteUrl = org.website_url ? String(org.website_url).trim() || null : null;
  if (!websiteUrl && domain) {
    websiteUrl = domain.startsWith('http') ? domain : `https://${domain}`;
  }

  return {
    name: String(org.name || 'Unknown').trim() || 'Unknown',
    legalName: null,
    domain,
    apolloOrganizationId: org.id ? String(org.id) : null,
    websiteUrl,
    email: null,
    phone: phone ? String(phone) : null,
    industry: null,
    employeeCount: null,
    annualRevenue: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    stateRegion: null,
    country: null,
    postalCode: null,
    linkedinUrl: org.linkedin_url ? String(org.linkedin_url).trim() || null : null,
    twitterUrl: org.twitter_url ? String(org.twitter_url).trim() || null : null,
    description: org.founded_year
      ? `Founded: ${org.founded_year}${org.alexa_ranking != null ? ` · Alexa: ${org.alexa_ranking}` : ''}`
      : null,
    notes: 'Imported from Apollo organization search',
    status,
  };
}

export async function apolloExtractDb(req, res) {
  try {
    if (!getApolloApiKey()) {
      return res.status(503).json({ error: 'Apollo API is not configured (set APOLLO_API_KEY).' });
    }
    const body = req.body || {};
    const filters = body.filters || {};
    if (!filtersNonEmpty(filters)) {
      return res.status(400).json({ error: 'Add at least one Apollo filter before extracting.' });
    }
    const status = normalizeStatus(body.status);
    const maxPages = Math.min(MAX_EXTRACT_PAGES, Math.max(1, parseInt(body.max_pages, 10) || MAX_EXTRACT_PAGES));
    const minFoundedYear = parseMinFoundedYear(body);

    let organizations;
    try {
      organizations = await fetchAllOrganizationsForFilters(filters, maxPages);
    } catch (e) {
      console.error('apolloExtractDb fetch error:', e);
      return res.status(e.status || 502).json({
        error: e.message || 'Failed to fetch all pages from Apollo',
        details: e.details,
      });
    }

    const totalFetchedFromApollo = organizations.length;
    organizations = filterOrganizationsByFoundedYear(organizations, minFoundedYear);
    const skippedFoundedYear = totalFetchedFromApollo - organizations.length;

    const repo = AppDataSource.getRepository(Company);
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const org of organizations) {
      const mapped = mapApolloOrgToCompany(org, status);
      if (!mapped.apolloOrganizationId) {
        skipped += 1;
        continue;
      }

      const existing = await repo.findOne({
        where: { apolloOrganizationId: mapped.apolloOrganizationId, deletedAt: null },
      });

      if (existing) {
        Object.assign(existing, {
          name: mapped.name,
          domain: mapped.domain ?? existing.domain,
          websiteUrl: mapped.websiteUrl ?? existing.websiteUrl,
          phone: mapped.phone ?? existing.phone,
          linkedinUrl: mapped.linkedinUrl ?? existing.linkedinUrl,
          twitterUrl: mapped.twitterUrl ?? existing.twitterUrl,
          description: mapped.description ?? existing.description,
          notes: mapped.notes ?? existing.notes,
          status: mapped.status,
        });
        await repo.save(existing);
        updated += 1;
      } else {
        const row = repo.create(mapped);
        await repo.save(row);
        created += 1;
      }
    }

    res.json({
      message: 'Import finished',
      minFoundedYear,
      totalFetchedFromApollo,
      totalMatchingFoundedYear: organizations.length,
      skippedFoundedYear,
      created,
      updated,
      skipped,
    });
  } catch (error) {
    console.error('apolloExtractDb error:', error);
    res.status(500).json({ error: 'Failed to import companies' });
  }
}

export async function listCompanySavedSearches(req, res) {
  try {
    const repo = AppDataSource.getRepository(CompanySavedSearch);
    const rows = await repo.find({ order: { updatedAt: 'DESC' } });
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        filters: JSON.parse(r.filtersJson || '{}'),
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
        updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
      })),
    });
  } catch (error) {
    console.error('listCompanySavedSearches error:', error);
    res.status(500).json({ error: 'Failed to list saved searches' });
  }
}

export async function createCompanySavedSearch(req, res) {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const filters = body.filters;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!filtersNonEmpty(filters)) {
      return res.status(400).json({ error: 'filters must include at least one Apollo field' });
    }

    const repo = AppDataSource.getRepository(CompanySavedSearch);
    const row = repo.create({
      name,
      filtersJson: JSON.stringify(filters),
    });
    const saved = await repo.save(row);
    res.status(201).json({
      id: saved.id,
      name: saved.name,
      filters: JSON.parse(saved.filtersJson || '{}'),
      createdAt: saved.createdAt instanceof Date ? saved.createdAt.toISOString() : saved.createdAt,
      updatedAt: saved.updatedAt instanceof Date ? saved.updatedAt.toISOString() : saved.updatedAt,
    });
  } catch (error) {
    console.error('createCompanySavedSearch error:', error);
    res.status(500).json({ error: 'Failed to save search' });
  }
}

export async function deleteCompanySavedSearch(req, res) {
  try {
    const repo = AppDataSource.getRepository(CompanySavedSearch);
    const r = await repo.delete({ id: req.params.savedSearchId });
    if (!r.affected) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (error) {
    console.error('deleteCompanySavedSearch error:', error);
    res.status(500).json({ error: 'Failed to delete saved search' });
  }
}
