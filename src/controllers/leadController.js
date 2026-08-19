import { AppDataSource } from '../config/database.js';
import { Client } from '../entities/Client.js';
import { LeadFilter } from '../entities/LeadFilter.js';
import { CrmClient } from '../entities/CrmClient.js';
import { MarketingAssignmentLead } from '../entities/MarketingAssignmentLead.js';
import { FollowupAssignmentLead } from '../entities/FollowupAssignmentLead.js';
import { In } from 'typeorm';
import fs from 'fs/promises';
import XLSX from 'xlsx';
import path from 'path';
import { verifyEmailsBulk } from '../services/millionsService.js';
import {
  fetchUncontactedVerifiedLeads,
  getUncontactedPoolStats,
  resetLeadsFromReady,
} from '../services/leadFetchService.js';
import { countOutboundEmailsInRange } from '../services/outboundEmailStatsService.js';
import { leadsToCsv } from '../utils/csvExport.js';
import { getFirstEmailFromCsvRow } from '../utils/csvLeadImport.js';
import { decodeCsvBuffer, preferRepairedName, repairImportedText } from '../utils/csvEncoding.js';
import {
  formatUncontactedLeadForExtension,
  sanitizeAiMarkerInName,
  serializeClientLeadForApi,
} from '../utils/leadNameSanitize.js';
import {
  normalizeLinkedInUrl,
  normalizeCompanyLinkedInUrl,
  extractLinkedInSlug,
  isApolloTool,
} from '../utils/linkedinUrl.js';
import {
  getJobTitlePriority,
  pickBestLeadPerCompany,
} from '../utils/jobTitlePriority.js';
import { ApolloAccount } from '../entities/ApolloAccount.js';
import { bulkEnrichPeopleByLinkedIn } from '../services/apolloEnrichmentService.js';
import { serializeCrmClient } from './crmClientController.js';

/** In-memory progress for async lead CSV uploads (polled by the upload UI). */
const leadUploadJobs = new Map();

function parseLocationFilter(query) {
  const raw = query.location;
  if (!raw) return [];
  const list = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  return list;
}

function applyLocationFilter(qb, locations, paramPrefix = 'loc') {
  if (!locations.length) return;
  const parts = [];
  const params = {};
  locations.forEach((loc, i) => {
    const key = `${paramPrefix}${i}`;
    parts.push(`(client.location ILIKE :${key} OR client.companyLocation ILIKE :${key})`);
    params[key] = `%${loc}%`;
  });
  qb.andWhere(`(${parts.join(' OR ')})`, params);
}

/** Shared list filters for GET /leads and CSV export. */
function applyLeadsListFilters(qb, query, { defaultStatusNew = false } = {}) {
  if (query.search) {
    qb.andWhere(
      '(client.email ILIKE :search OR client.firstName ILIKE :search OR client.lastName ILIKE :search OR client.companyName ILIKE :search)',
      { search: `%${query.search}%` }
    );
  }

  if (query.status) {
    if (query.status === 'new') {
      qb.andWhere('(client.status = :status OR client.status IS NULL)', { status: query.status });
    } else {
      qb.andWhere('client.status = :status', { status: query.status });
    }
  } else if (defaultStatusNew) {
    qb.andWhere('(client.status = :status OR client.status IS NULL)', { status: 'new' });
  }

  applyLocationFilter(qb, parseLocationFilter(query));

  if (query.leadFilterIds) {
    const leadFilterIds = Array.isArray(query.leadFilterIds)
      ? query.leadFilterIds
      : query.leadFilterIds.split(',').filter((id) => id.trim());
    const filterMode = query.leadFilterMode || 'include';

    if (leadFilterIds.length > 0) {
      if (filterMode === 'exclude') {
        qb.andWhere(
          '(client.leadFilterId IS NULL OR client.leadFilterId NOT IN (:...leadFilterIds))',
          { leadFilterIds }
        );
      } else {
        qb.andWhere('client.leadFilterId IN (:...leadFilterIds)', { leadFilterIds });
      }
    }
  }

  if (query.assignedTo || query.contactedBy) {
    const assignedTo = query.assignedTo || query.contactedBy;
    qb.andWhere('client.contactedBy LIKE :assignedTo', { assignedTo: `%${assignedTo}%` });
  }
}

function hasLeadsListFilters(query) {
  return Boolean(
    query.search ||
      query.status ||
      query.location ||
      query.assignedTo ||
      query.contactedBy ||
      query.leadFilterIds
  );
}

export async function getLeads(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const clientRepository = AppDataSource.getRepository(Client);

    const queryBuilder = clientRepository
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL');

    applyLeadsListFilters(queryBuilder, req.query);

    const dataQuery = queryBuilder
      .orderBy('client.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    const countQuery = clientRepository
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL');

    applyLeadsListFilters(countQuery, req.query);

    const [data, total] = await Promise.all([
      dataQuery.getMany(),
      countQuery.getCount(),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.json({
      data: data.map(serializeClientLeadForApi),
      page,
      limit,
      total,
      totalPages,
    });
  } catch (error) {
    console.error('Get leads error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Return candidate lead emails for follow-up:
 * - sent by a specific account, not already followed up
 * - daysAgo / sentOnOrBefore are hints for the extension; Gmail row date applies the cutoff
 * - not deleted, has email
 */
export async function getFollowupCandidates(req, res) {
  try {
    const sentBy = String(req.query.sentBy || req.query.sentByEmail || '').trim().toLowerCase();
    const daysAgoRaw = parseInt(String(req.query.daysAgo || req.query.days || '0'), 10);
    const limitRaw = parseInt(String(req.query.limit || '400'), 10);

    if (!sentBy || !sentBy.includes('@')) {
      return res.status(400).json({ error: 'sentBy (email) query param is required' });
    }
    if (!Number.isFinite(daysAgoRaw) || daysAgoRaw < 1) {
      return res.status(400).json({ error: 'daysAgo must be an integer >= 1' });
    }

    const minDaysSinceSend = Math.min(365, daysAgoRaw);
    const limit = Math.min(20000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 5000));

    const sentOnOrBefore = new Date();
    sentOnOrBefore.setHours(0, 0, 0, 0);
    sentOnOrBefore.setDate(sentOnOrBefore.getDate() - minDaysSinceSend);
    sentOnOrBefore.setHours(23, 59, 59, 999);

    const clientRepository = AppDataSource.getRepository(Client);
    const rows = await clientRepository
      .createQueryBuilder('client')
      .select(['client.email', 'client.lastSent'])
      .where('client.deletedAt IS NULL')
      .andWhere('client.email IS NOT NULL')
      .andWhere("TRIM(client.email) <> ''")
      .andWhere('client.lastSent IS NOT NULL')
      .andWhere('(client.isFollowup = false OR client.isFollowup IS NULL)')
      .andWhere('LOWER(COALESCE(client.sentBy, \'\')) LIKE :sentBy', {
        sentBy: `%${sentBy}%`,
      })
      .orderBy('client.lastSent', 'DESC')
      .limit(limit)
      .getMany();

    const seen = new Set();
    const emails = [];
    for (const row of rows) {
      const email = String(row?.email || '').trim().toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      emails.push(email);
    }

    res.json({
      sentBy,
      daysAgo: minDaysSinceSend,
      minDaysSinceSend,
      sentOnOrBefore: sentOnOrBefore.toISOString(),
      totalMatchedRows: rows.length,
      totalCandidateEmails: emails.length,
      emails,
    });
  } catch (error) {
    console.error('getFollowupCandidates error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function downloadNewLeadsCsv(req, res) {
  try {
    const clientRepository = AppDataSource.getRepository(Client);
    const qb = clientRepository
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL');

    // Match current table filters when provided; otherwise export all "new" leads.
    applyLeadsListFilters(qb, req.query, { defaultStatusNew: !hasLeadsListFilters(req.query) });

    const leads = await qb.orderBy('client.createdAt', 'DESC').getMany();
    const sanitizedLeads = leads.map(serializeClientLeadForApi);

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(
      now.getUTCHours()
    )}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;

    const csvBody = leadsToCsv(sanitizedLeads);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="new-leads-${stamp}.csv"`);
    res.status(200).send('\uFEFF' + csvBody);
  } catch (error) {
    console.error('downloadNewLeadsCsv error:', error);
    res.status(500).json({ error: 'Failed to export new leads CSV' });
  }
}

export async function createLead(req, res) {
  try {
    const clientRepository = AppDataSource.getRepository(Client);
    const leadFilterRepository = AppDataSource.getRepository(LeadFilter);

    // Create LeadFilter if provided
    let leadFilterId = null;
    if (req.body.leadFilter) {
      const leadFilterData = {
        industries: req.body.leadFilter.industries || null,
        locations: req.body.leadFilter.locations || null,
        tool: req.body.leadFilter.tool || null,
        rating: req.body.leadFilter.rating || null,
      };
      const leadFilter = leadFilterRepository.create(leadFilterData);
      const savedLeadFilter = await leadFilterRepository.save(leadFilter);
      leadFilterId = savedLeadFilter.id;
    }

    // Map request body to Client entity fields
    const clientData = {
      email: (req.body.email || req.body.Email || '').toLowerCase(),
      firstName: sanitizeAiMarkerInName(req.body.firstName) || null,
      lastName: sanitizeAiMarkerInName(req.body.lastName) || null,
      companyName: sanitizeAiMarkerInName(req.body.companyName || req.body.company) || null,
      companyUrl: req.body.companyUrl || req.body.website || null,
      linkedin: req.body.linkedin || null,
      jobTitle: req.body.jobTitle || req.body.title || null,
      location: req.body.location || (req.body.city && req.body.state ? `${req.body.city}, ${req.body.state}` : req.body.city || req.body.state || null),
      companyLocation: req.body.companyLocation || (req.body.country || null),
      status: req.body.status || 'new',
      contactedBy: req.body.contactedBy || (req.body.assignedTo ? [req.body.assignedTo] : null),
      industries: req.body.industries || null,
      templateIndustry: (() => {
        const raw = String(req.body.templateIndustry || req.body.template_industry || '').trim();
        return raw || null;
      })(),
      tech: req.body.tech || null,
      employees: req.body.employees || null,
      photoUrl: req.body.photoUrl || null,
      isSent: req.body.isSent || false,
      isReplied: req.body.isReplied || false,
      note: req.body.note || null,
      leadFilterId: leadFilterId,
    };

    if (!clientData.email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Check if client already exists
    const existing = await clientRepository.findOne({
      where: { email: clientData.email, deletedAt: null },
    });

    if (existing) {
      return res.status(400).json({ error: 'Lead with this email already exists' });
    }

    const client = clientRepository.create(clientData);
    const savedClient = await clientRepository.save(client);

    res.status(201).json(savedClient);
  } catch (error) {
    console.error('Create lead error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Lead with this email already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function uploadLeads(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const jobId = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const job = {
      jobId,
      status: 'processing',
      phase: 'queued',
      message: 'Upload received — starting import…',
      percent: 1,
      processed: 0,
      total: 0,
      created: 0,
      updated: 0,
      errorCount: 0,
      errors: undefined,
      startTime: new Date(),
      endTime: null,
    };
    leadUploadJobs.set(jobId, job);

    // Return immediately so the UI can poll progress (avoids gateway timeouts on large CSVs).
    res.status(202).json({
      success: true,
      jobId,
      status: 'processing',
      message: job.message,
    });

    const failJob = (message) => {
      const j = leadUploadJobs.get(jobId);
      if (!j) return;
      j.status = 'error';
      j.phase = 'error';
      j.message = message;
      j.percent = 100;
      j.endTime = new Date();
    };

    const patchJob = (patch) => {
      const j = leadUploadJobs.get(jobId);
      if (!j || j.status === 'error') return;
      Object.assign(j, patch);
    };

    try {
    const clientRepository = AppDataSource.getRepository(Client);
    const leadFilterRepository = AppDataSource.getRepository(LeadFilter);
    const results = [];
    const errors = [];
    let processed = 0;

    // Counters for each skip/error reason category shown in the UI
    const skipCounts = {
      duplicate: 0,      // lead already exists (no update needed)
      noEmail: 0,        // email missing / LinkedIn required
      lowerTitle: 0,     // same company has higher-priority title
      parseError: 0,     // row-level parse / save exception
    };

    patchJob({ phase: 'preparing', message: 'Preparing lead filter…', percent: 3 });

    // Parse LeadFilter from request if provided
    let leadFilterId = null;
    let leadFilterMillionsStatus = null;
    let uploadTool = null;
    if (req.body.leadFilter) {
      try {
        const leadFilterData = typeof req.body.leadFilter === 'string' 
          ? JSON.parse(req.body.leadFilter) 
          : req.body.leadFilter;
        
        uploadTool = leadFilterData.tool || null;

        if (leadFilterData.industries?.length || leadFilterData.locations?.length || leadFilterData.tool || leadFilterData.rating) {
          const leadFilter = leadFilterRepository.create({
            industries: leadFilterData.industries || null,
            locations: leadFilterData.locations || null,
            tool: leadFilterData.tool || null,
            rating: leadFilterData.rating || null,
          });
          const savedLeadFilter = await leadFilterRepository.save(leadFilter);
          leadFilterId = savedLeadFilter.id;
        }

        // Optional: apply Millions status from filter to all uploaded leads
        if (leadFilterData.millionsStatus) {
          const normalized = String(leadFilterData.millionsStatus).trim().toLowerCase();
          if (['good', 'risky', 'bad', 'error'].includes(normalized)) {
            leadFilterMillionsStatus = normalized;
          }
        }
      } catch (err) {
        console.error('Error parsing LeadFilter:', err);
      }
    }

    const allowMissingEmail = isApolloTool(uploadTool);

    const uploadTemplateIndustry = (() => {
      const raw = String(req.body.templateIndustry || req.body.template_industry || '').trim();
      return raw || null;
    })();

    // Read and parse file (CSV or XLSX)
    const filePath = req.file.path;
    const fileExtension = path.extname(req.file.originalname).toLowerCase().slice(1);
    const rows = [];

    patchJob({ phase: 'parsing', message: 'Reading and parsing file…', percent: 8 });

    if (fileExtension === 'csv') {
      // Parse CSV — detect encoding (Excel often exports Windows-1250/1252, not UTF-8)
      const fileBuffer = await fs.readFile(filePath);
      const { text: fileContent, encoding: csvEncoding } = decodeCsvBuffer(fileBuffer);
      if (csvEncoding !== 'utf-8') {
        console.log(`[uploadLeads] Decoded CSV as ${csvEncoding}`);
      }
      const lines = fileContent.split(/\r?\n/).filter(line => line.trim());

      if (lines.length < 2) {
        await fs.unlink(filePath).catch(() => {});
        return failJob('CSV file must have at least a header and one data row');
      }

      // Parse CSV (handle quoted values)
      function parseCSVLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          if (char === '"') {
            inQuotes = !inQuotes;
          } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
          } else {
            current += char;
          }
        }
        result.push(current.trim());
        return result;
      }

      // Parse header
      const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, ''));

      // Parse data rows
      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        const row = {};

        headers.forEach((header, index) => {
          if (values[index]) {
            row[header] = values[index];
          }
        });
        rows.push(row);
        if (i % 500 === 0 || i === lines.length - 1) {
          const parsePct = 8 + Math.round((i / Math.max(1, lines.length - 1)) * 12);
          patchJob({
            phase: 'parsing',
            message: `Parsing CSV rows… ${i}/${lines.length - 1}`,
            percent: Math.min(20, parsePct),
            total: lines.length - 1,
          });
        }
      }
    } else if (fileExtension === 'xlsx' || fileExtension === 'xls') {
      // Parse XLSX/XLS
      try {
        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

        if (data.length < 2) {
          await fs.unlink(filePath).catch(() => {});
          return failJob('Excel file must have at least a header and one data row');
        }

        const headers = data[0].map(h => String(h).toLowerCase().replace(/\s+/g, ''));

        for (let i = 1; i < data.length; i++) {
          const rowData = data[i];
          const row = {};
          headers.forEach((header, index) => {
            if (rowData[index] !== undefined && rowData[index] !== null && rowData[index] !== '') {
              row[header] = String(rowData[index]);
            }
          });
          rows.push(row);
        }
        patchJob({
          phase: 'parsing',
          message: `Parsed ${rows.length} Excel rows`,
          percent: 20,
          total: rows.length,
        });
      } catch (error) {
        await fs.unlink(filePath).catch(() => {});
        return failJob(`Error parsing Excel file: ${error.message}`);
      }
    } else {
      await fs.unlink(filePath).catch(() => {});
      return failJob('Unsupported file format. Please use CSV, XLSX, or XLS.');
    }

    // Helper function to get field value from multiple possible column names
    function getField(row, ...fieldNames) {
      for (const fieldName of fieldNames) {
        const value = row[fieldName];
        if (value !== undefined && value !== null && value !== '') {
          return value;
        }
      }
      return null;
    }

    // Helper function to split name into firstName and lastName
    function splitName(fullName) {
      if (!fullName || typeof fullName !== 'string') {
        return { firstName: null, lastName: null };
      }
      const trimmed = fullName.trim();
      if (!trimmed) {
        return { firstName: null, lastName: null };
      }
      const parts = trimmed.split(/\s+/);
      if (parts.length === 1) {
        return { firstName: parts[0], lastName: null };
      }
      const firstName = parts[0];
      const lastName = parts.slice(1).join(' ');
      return { firstName, lastName };
    }

    async function findExistingByLinkedin(linkedinUrl) {
      const normalized = normalizeLinkedInUrl(linkedinUrl);
      const slug = extractLinkedInSlug(linkedinUrl);
      if (!normalized && !slug) return null;

      if (slug) {
        const bySlug = await clientRepository
          .createQueryBuilder('client')
          .where('client.deletedAt IS NULL')
          .andWhere('client.linkedin IS NOT NULL')
          .andWhere("LOWER(client.linkedin) LIKE :pat", { pat: `%/in/${slug}%` })
          .getOne();
        if (bySlug) return bySlug;
      }

      if (normalized) {
        return clientRepository
          .createQueryBuilder('client')
          .where('client.deletedAt IS NULL')
          .andWhere('LOWER(TRIM(client.linkedin)) = :linkedin', { linkedin: normalized })
          .getOne();
      }
      return null;
    }

    // Pass 1: parse rows into candidates
    patchJob({
      phase: 'mapping',
      message: `Mapping ${rows.length} rows…`,
      percent: 22,
      total: rows.length,
    });
    const candidates = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      try {
        // Email: primary column, then Email_2, Email_3, … (ContactOut export)
        const rawEmail = getFirstEmailFromCsvRow(row);
        const email = rawEmail ? String(rawEmail).toLowerCase().trim() : '';

        // Handle LinkedIn profile URL - check multiple variations
        let linkedinUrl = getField(
          row,
          'linkedin',
          'linkedinprofile',
          'linkedin_profile',
          'personlinkedinurl',
          'person_linkedin_url',
          'linkedinurl',
          'linkedin_url',
          'linkedinprofileurl',
          'linkedin_profile_url'
        );
        if (linkedinUrl) {
          linkedinUrl = normalizeLinkedInUrl(linkedinUrl);
        }

        if (!email) {
          if (!allowMissingEmail) {
            errors.push({ row: i + 2, error: 'Email is required', reason: 'noEmail' });
            skipCounts.noEmail++;
            continue;
          }
          if (!linkedinUrl) {
            errors.push({
              row: i + 2,
              error: 'LinkedIn URL is required when uploading Apollo leads without email',
              reason: 'noEmail',
            });
            skipCounts.noEmail++;
            continue;
          }
        }

        // Handle company URL/domain - check multiple variations
        let companyUrl = getField(
          row,
          'website',
          'companyurl',
          'company_url',
          'companydomain',
          'company_domain',
          'companywebsite',
          'company_website',
          'domain'
        );
        if (companyUrl) {
          companyUrl = companyUrl.trim();
          if (companyUrl && !companyUrl.startsWith('http') && companyUrl.includes('.')) {
            companyUrl = `https://${companyUrl}`;
          }
        }

        const companyLinkedin = normalizeCompanyLinkedInUrl(
          getField(
            row,
            'companylinkedinurl',
            'company_linkedin_url',
            'companylinkedin',
            'company_linkedin',
            'organizationlinkedinurl',
            'organization_linkedin_url',
            'companylinkedinprofile'
          )
        );

        // Handle Name field - if only Name exists, split it into firstName and lastName
        const nameField = getField(row, 'name', 'fullname', 'full_name');
        let firstName = getField(row, 'firstname', 'first_name', 'firstname', 'fname', 'f_name', 'givenname', 'given_name');
        let lastName = getField(row, 'lastname', 'last_name', 'lastname', 'lname', 'l_name', 'surname', 'familyname', 'family_name');

        // If Name field exists and firstName/lastName are not present, split the Name field
        if (nameField && !firstName && !lastName) {
          const split = splitName(nameField);
          firstName = split.firstName;
          lastName = split.lastName;
        }

        // Handle company name - check multiple variations
        const companyName = getField(
          row,
          'company',
          'companyname',
          'company_name',
          'companynameforemails',
          'company_name_for_emails',
          'organization',
          'org',
          'companyname',
          'company'
        );

        // Handle job title - check multiple variations
        const jobTitle = getField(row, 'title', 'jobtitle', 'job_title', 'position', 'role', 'job', 'jobtitle');

        // Handle location - check multiple variations
        let location = null;
        const city = getField(row, 'city', 'locationcity', 'location_city');
        const state = getField(row, 'state', 'locationstate', 'location_state', 'province', 'region');
        const country = getField(row, 'country', 'locationcountry', 'location_country');
        
        if (city && state) {
          location = `${city}, ${state}`;
          if (country) location += `, ${country}`;
        } else {
          location = getField(row, 'location', 'address', 'fulladdress', 'full_address') || city || state || country;
        }

        // Handle company location
        const companyLocation = getField(
          row,
          'companycountry',
          'company_country',
          'companylocation',
          'company_location',
          'companycity',
          'company_city'
        ) || country;

        // Handle Millions verification status (manual CSV column)
        const rawMillionsStatus = getField(
          row,
          'millionsstatus',
          'millions_status',
          'millionsverificationstatus',
          'millions_verification_status',
          'millions'
        );

        // If a Millions status was provided in the Lead Filter, use that for all rows.
        // Otherwise, fall back to any per-row CSV value.
        let millionsStatus = leadFilterMillionsStatus || null;
        if (rawMillionsStatus) {
          const normalized = String(rawMillionsStatus).trim().toLowerCase();
          // Normalize common variants to the core statuses used in the app
          if (['good', 'risky', 'bad', 'error'].includes(normalized)) {
            millionsStatus = normalized;
          } else if (['valid', 'deliverable'].includes(normalized)) {
            millionsStatus = 'good';
          } else if (['risky-valid', 'riskyvalid', 'risky_deliverable'].includes(normalized)) {
            millionsStatus = 'risky';
          } else if (['invalid', 'undeliverable', 'blocklisted', 'blocked'].includes(normalized)) {
            millionsStatus = 'bad';
          }
          // Any other values (including "unknown"/"unverified") are treated as null/unset
        }

        const clientData = {
          email: email || null,
          firstName: sanitizeAiMarkerInName(repairImportedText(firstName)) || null,
          lastName: sanitizeAiMarkerInName(repairImportedText(lastName)) || null,
          companyName: sanitizeAiMarkerInName(repairImportedText(companyName)) || null,
          companyUrl: companyUrl || null,
          companyLinkedin: companyLinkedin || null,
          linkedin: linkedinUrl || null,
          jobTitle: repairImportedText(jobTitle) || null,
          location: repairImportedText(location) || null,
          companyLocation: repairImportedText(companyLocation) || null,
          status: getField(row, 'status') || 'new',
          contactedBy: (() => {
            const value = getField(row, 'assignedto', 'assigned_to', 'contactedby', 'contacted_by');
            return value ? [value] : null;
          })(),
          industries: (() => {
            const value = getField(row, 'industries', 'industry');
            if (!value) return null;
            return Array.isArray(value) ? value : value.split(',').map(i => i.trim()).filter(i => i);
          })(),
          templateIndustry: (() => {
            const fromRow = getField(row, 'templateindustry', 'template_industry', 'templateIndustry');
            const raw = String(fromRow || uploadTemplateIndustry || '').trim();
            return raw || null;
          })(),
          tech: (() => {
            const value = getField(row, 'tech', 'technologies', 'technology');
            if (!value) return null;
            return Array.isArray(value) ? value : value.split(',').map(t => t.trim()).filter(t => t);
          })(),
          leadFilterId: leadFilterId,
          millionsStatus,
        };

        candidates.push({
          rowIndex: i,
          companyKey: companyLinkedin || null,
          titlePriority: getJobTitlePriority(jobTitle),
          clientData,
        });
      } catch (error) {
        errors.push({ row: i + 2, error: error.message, reason: 'parseError' });
        skipCounts.parseError++;
      }

      if (i % 200 === 0 || i === rows.length - 1) {
        const mapPct = 22 + Math.round(((i + 1) / Math.max(1, rows.length)) * 18);
        patchJob({
          phase: 'mapping',
          message: `Mapping rows… ${i + 1}/${rows.length}`,
          percent: Math.min(40, mapPct),
          processed: i + 1,
          total: rows.length,
          errorCount: errors.length,
        });
      }
    }

    // Pass 2: keep only highest-priority title per company LinkedIn URL (CEO > CTO, etc.)
    patchJob({
      phase: 'deduping',
      message: 'Deduplicating by company…',
      percent: 42,
    });
    const { winners, skipped } = pickBestLeadPerCompany(candidates);
    for (const { candidate, kept } of skipped) {
      const keptTitle = kept.clientData.jobTitle || 'higher-priority title';
      errors.push({
        row: candidate.rowIndex + 2,
        email: candidate.clientData.email || undefined,
        linkedin: candidate.clientData.linkedin || undefined,
        error: `Skipped: same company already has ${keptTitle} (prefer CEO over other roles)`,
        reason: 'lowerTitle',
      });
      skipCounts.lowerTitle++;
    }

    async function findExistingAtCompany(companyLinkedin) {
      if (!companyLinkedin) return [];
      return clientRepository
        .createQueryBuilder('client')
        .where('client.deletedAt IS NULL')
        .andWhere('client.companyLinkedin IS NOT NULL')
        .andWhere('LOWER(TRIM(client.companyLinkedin)) = :companyLinkedin', {
          companyLinkedin: companyLinkedin.toLowerCase(),
        })
        .getMany();
    }

    // Pass 3: insert / update winners
    patchJob({
      phase: 'importing',
      message: `Importing ${winners.length} leads…`,
      percent: 45,
      processed: 0,
      total: winners.length,
      errorCount: errors.length,
    });
    for (let wi = 0; wi < winners.length; wi++) {
      const candidate = winners[wi];
      const { rowIndex: i, clientData, titlePriority } = candidate;

      try {
        // Dedupe: email when present; otherwise LinkedIn (Apollo no-email uploads)
        let existing = null;
        if (clientData.email) {
          existing = await clientRepository.findOne({
            where: { email: clientData.email, deletedAt: null },
          });
        }
        if (!existing && clientData.linkedin) {
          existing = await findExistingByLinkedin(clientData.linkedin);
        }

        // If this person is new, skip when platform already has equal/higher title at same company
        if (!existing && clientData.companyLinkedin) {
          const sameCompany = await findExistingAtCompany(clientData.companyLinkedin);
          const betterOrEqual = sameCompany.find(
            (c) => getJobTitlePriority(c.jobTitle) >= titlePriority
          );
          if (betterOrEqual) {
            errors.push({
              row: i + 2,
              email: clientData.email || undefined,
              linkedin: clientData.linkedin || undefined,
              error: `Skipped: company already has ${betterOrEqual.jobTitle || 'a lead'} on platform (prefer CEO over other roles)`,
              reason: 'lowerTitle',
            });
            skipCounts.lowerTitle++;
            continue;
          }
        }

        if (!existing) {
          const client = clientRepository.create(clientData);
          const savedClient = await clientRepository.save(client);
          results.push(savedClient);
          processed++;
        } else {
          // Client exists - check if firstName or lastName need to be updated
          const updateData = {};
          let needsUpdate = false;

          // Update firstName if it's missing in DB but present in upload
          if (!existing.firstName && clientData.firstName) {
            updateData.firstName = clientData.firstName;
            needsUpdate = true;
          } else {
            const repairedFirst = preferRepairedName(existing.firstName, clientData.firstName);
            if (repairedFirst) {
              updateData.firstName = repairedFirst;
              needsUpdate = true;
            }
          }

          // Update lastName if it's missing in DB but present in upload
          if (!existing.lastName && clientData.lastName) {
            updateData.lastName = clientData.lastName;
            needsUpdate = true;
          } else {
            const repairedLast = preferRepairedName(existing.lastName, clientData.lastName);
            if (repairedLast) {
              updateData.lastName = repairedLast;
              needsUpdate = true;
            }
          }

          if (!existing.companyName && clientData.companyName) {
            updateData.companyName = clientData.companyName;
            needsUpdate = true;
          } else {
            const repairedCompany = preferRepairedName(existing.companyName, clientData.companyName);
            if (repairedCompany) {
              updateData.companyName = repairedCompany;
              needsUpdate = true;
            }
          }

          if (!existing.jobTitle && clientData.jobTitle) {
            updateData.jobTitle = clientData.jobTitle;
            needsUpdate = true;
          } else {
            const repairedTitle = preferRepairedName(existing.jobTitle, clientData.jobTitle);
            if (repairedTitle) {
              updateData.jobTitle = repairedTitle;
              needsUpdate = true;
            }
          }

          if (!existing.location && clientData.location) {
            updateData.location = clientData.location;
            needsUpdate = true;
          } else {
            const repairedLocation = preferRepairedName(existing.location, clientData.location);
            if (repairedLocation) {
              updateData.location = repairedLocation;
              needsUpdate = true;
            }
          }

          if (!existing.companyLocation && clientData.companyLocation) {
            updateData.companyLocation = clientData.companyLocation;
            needsUpdate = true;
          } else {
            const repairedCompanyLocation = preferRepairedName(
              existing.companyLocation,
              clientData.companyLocation
            );
            if (repairedCompanyLocation) {
              updateData.companyLocation = repairedCompanyLocation;
              needsUpdate = true;
            }
          }

          if (!existing.templateIndustry && clientData.templateIndustry) {
            updateData.templateIndustry = clientData.templateIndustry;
            needsUpdate = true;
          }

          if (!existing.linkedin && clientData.linkedin) {
            updateData.linkedin = clientData.linkedin;
            needsUpdate = true;
          }

          // Fill email on existing LinkedIn-matched Apollo lead if we now have one
          if (!existing.email && clientData.email) {
            updateData.email = clientData.email;
            needsUpdate = true;
          }

          if (!existing.companyLinkedin && clientData.companyLinkedin) {
            updateData.companyLinkedin = clientData.companyLinkedin;
            needsUpdate = true;
          }

          if (!existing.leadFilterId && clientData.leadFilterId) {
            updateData.leadFilterId = clientData.leadFilterId;
            needsUpdate = true;
          }

          if (needsUpdate) {
            await clientRepository.update({ id: existing.id }, updateData);
            const updatedClient = await clientRepository.findOne({
              where: { id: existing.id },
            });
            results.push(updatedClient);
            processed++;
          } else {
            errors.push({
              row: i + 2,
              email: clientData.email || undefined,
              linkedin: clientData.linkedin || undefined,
              error: 'Lead already exists',
              reason: 'duplicate',
            });
            skipCounts.duplicate++;
          }
        }
      } catch (error) {
        errors.push({ row: i + 2, error: error.message, reason: 'parseError' });
        skipCounts.parseError++;
      }

      if (wi % 25 === 0 || wi === winners.length - 1) {
        const importPct = 45 + Math.round(((wi + 1) / Math.max(1, winners.length)) * 50);
        patchJob({
          phase: 'importing',
          message: `Importing leads… ${wi + 1}/${winners.length}`,
          percent: Math.min(95, importPct),
          processed: wi + 1,
          total: winners.length,
          created: results.length,
          errorCount: errors.length,
          skipCounts: { ...skipCounts },
        });
      }
    }

    // Clean up uploaded file
    try {
      await fs.unlink(filePath);
    } catch (err) {
      console.error('Error deleting temp file:', err);
    }

    // Build human-readable breakdown for the done message
    const skipParts = [];
    if (skipCounts.duplicate)  skipParts.push(`${skipCounts.duplicate} duplicate`);
    if (skipCounts.lowerTitle) skipParts.push(`${skipCounts.lowerTitle} lower-title`);
    if (skipCounts.noEmail)    skipParts.push(`${skipCounts.noEmail} no-email`);
    if (skipCounts.parseError) skipParts.push(`${skipCounts.parseError} error`);
    const skipSummary = skipParts.length ? ` · ${skipParts.join(' · ')}` : '';

    patchJob({
      status: 'completed',
      phase: 'completed',
      message: `Done — ${results.length} saved${skipSummary}`,
      percent: 100,
      processed: winners.length,
      total: winners.length,
      created: results.length,
      errorCount: errors.length,
      skipCounts: { ...skipCounts },
      errors: errors.length > 0 ? errors.slice(0, 100) : undefined,
      endTime: new Date(),
    });
    } catch (innerError) {
      console.error('Upload leads job error:', innerError);
      failJob(innerError?.message || 'Internal server error');
      try {
        if (req.file?.path) await fs.unlink(req.file.path);
      } catch {
        // ignore cleanup errors
      }
    }
  } catch (error) {
    console.error('Upload leads error:', error);
    // Only reached if we failed before sending 202
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

export async function getLeadUploadStatus(req, res) {
  try {
    const { jobId } = req.params;
    if (!jobId) {
      return res.status(400).json({ error: 'jobId is required' });
    }
    const job = leadUploadJobs.get(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Upload job not found' });
    }
    res.json(job);
  } catch (error) {
    console.error('Get lead upload status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getLeadById(req, res) {
  try {
    const { id } = req.params;
    const clientRepository = AppDataSource.getRepository(Client);
    const lead = await clientRepository.findOne({
      where: { id, deletedAt: null },
    });
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    res.json(serializeClientLeadForApi(lead));
  } catch (error) {
    console.error('Get lead by id error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateLead(req, res) {
  try {
    const { id } = req.params;
    const clientRepository = AppDataSource.getRepository(Client);
    const existing = await clientRepository.findOne({
      where: { id, deletedAt: null },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const body = req.body || {};
    const stringOrNull = (v) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const s = String(v).trim();
      return s || null;
    };

    const patch = {};
    if (body.email !== undefined) {
      const email = String(body.email || '').toLowerCase().trim();
      if (!email) {
        return res.status(400).json({ error: 'Email cannot be empty' });
      }
      if (email !== (existing.email || '').toLowerCase()) {
        const dup = await clientRepository.findOne({
          where: { email, deletedAt: null },
        });
        if (dup && dup.id !== existing.id) {
          return res.status(400).json({ error: 'Lead with this email already exists' });
        }
      }
      patch.email = email;
    }

    const nameFields = ['firstName', 'lastName', 'companyName'];
    for (const field of nameFields) {
      if (body[field] !== undefined || (field === 'companyName' && body.company !== undefined)) {
        const raw = field === 'companyName' && body.companyName === undefined ? body.company : body[field];
        patch[field] = sanitizeAiMarkerInName(stringOrNull(raw));
      }
    }

    if (body.companyUrl !== undefined || body.website !== undefined) {
      patch.companyUrl = stringOrNull(body.companyUrl ?? body.website);
    }
    if (body.companyLinkedin !== undefined) {
      patch.companyLinkedin = normalizeCompanyLinkedInUrl(body.companyLinkedin) || stringOrNull(body.companyLinkedin);
    }
    if (body.linkedin !== undefined) {
      patch.linkedin = normalizeLinkedInUrl(body.linkedin) || stringOrNull(body.linkedin);
    }
    if (body.jobTitle !== undefined || body.title !== undefined) {
      patch.jobTitle = stringOrNull(body.jobTitle ?? body.title);
    }
    if (body.location !== undefined) patch.location = stringOrNull(body.location);
    if (body.companyLocation !== undefined || body.country !== undefined) {
      patch.companyLocation = stringOrNull(body.companyLocation ?? body.country);
    }
    if (body.status !== undefined) patch.status = stringOrNull(body.status) || 'new';
    if (body.templateIndustry !== undefined || body.template_industry !== undefined) {
      patch.templateIndustry = stringOrNull(body.templateIndustry ?? body.template_industry);
    }
    if (body.note !== undefined) patch.note = stringOrNull(body.note);
    if (body.photoUrl !== undefined) patch.photoUrl = stringOrNull(body.photoUrl);
    if (body.employees !== undefined) {
      patch.employees = body.employees === null || body.employees === '' ? null : Number(body.employees);
    }
    if (body.isSent !== undefined) patch.isSent = Boolean(body.isSent);
    if (body.isReplied !== undefined) patch.isReplied = Boolean(body.isReplied);
    if (body.isFollowup !== undefined) patch.isFollowup = Boolean(body.isFollowup);
    if (body.millionsStatus !== undefined) patch.millionsStatus = stringOrNull(body.millionsStatus);
    if (body.lastSent !== undefined) {
      patch.lastSent = body.lastSent ? new Date(body.lastSent) : null;
    }
    if (body.contactedBy !== undefined || body.assignedTo !== undefined) {
      const raw = body.contactedBy !== undefined ? body.contactedBy : body.assignedTo;
      if (raw === null || raw === '') patch.contactedBy = null;
      else if (typeof raw === 'string') patch.contactedBy = [raw];
      else if (Array.isArray(raw)) patch.contactedBy = raw;
      else patch.contactedBy = null;
    }
    if (body.industries !== undefined) {
      if (body.industries === null || body.industries === '') patch.industries = null;
      else if (Array.isArray(body.industries)) patch.industries = body.industries;
      else patch.industries = String(body.industries).split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (body.tech !== undefined) {
      if (body.tech === null || body.tech === '') patch.tech = null;
      else if (Array.isArray(body.tech)) patch.tech = body.tech;
      else patch.tech = String(body.tech).split(',').map((s) => s.trim()).filter(Boolean);
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    await clientRepository.update({ id }, patch);
    const updated = await clientRepository.findOne({ where: { id } });
    res.json(serializeClientLeadForApi(updated));
  } catch (error) {
    console.error('Update lead error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Lead with this email already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteLead(req, res) {
  try {
    const { id } = req.params;
    const clientRepository = AppDataSource.getRepository(Client);
    const existing = await clientRepository.findOne({
      where: { id, deletedAt: null },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    await clientRepository.update({ id }, { deletedAt: new Date() });
    res.json({ success: true, deleted: 1 });
  } catch (error) {
    console.error('Delete lead error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Lead detail + per-mailbox send/CRM flow.
 * Multiple accounts can have used the same lead; group history by account email.
 */
export async function getLeadHistory(req, res) {
  try {
    const { id } = req.params;
    const clientRepository = AppDataSource.getRepository(Client);
    const lead = await clientRepository.findOne({
      where: { id, deletedAt: null },
    });
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const marketingRows = await AppDataSource.getRepository(MarketingAssignmentLead)
      .createQueryBuilder('mal')
      .leftJoinAndSelect('mal.assignment', 'assignment')
      .leftJoinAndSelect('assignment.email', 'email')
      .where('mal.clientId = :clientId', { clientId: id })
      .orderBy('mal.createdAt', 'DESC')
      .getMany();

    const followupRows = await AppDataSource.getRepository(FollowupAssignmentLead)
      .createQueryBuilder('fal')
      .leftJoinAndSelect('fal.assignment', 'assignment')
      .leftJoinAndSelect('assignment.email', 'email')
      .where('fal.clientId = :clientId', { clientId: id })
      .orderBy('fal.createdAt', 'DESC')
      .getMany();

    const crmRows = await AppDataSource.getRepository(CrmClient)
      .createQueryBuilder('c')
      .where('c.deletedAt IS NULL')
      .andWhere('(c.leadId = :leadId OR LOWER(TRIM(c.email)) = :email)', {
        leadId: id,
        email: String(lead.email || '').toLowerCase().trim() || '__none__',
      })
      .getMany();

    /** @type {Map<string, { accountEmail: string, coldSends: any[], followups: any[], crmClients: any[] }>} */
    const byAccount = new Map();

    function ensureAccount(rawEmail) {
      const accountEmail = String(rawEmail || '').trim().toLowerCase();
      if (!accountEmail) return null;
      if (!byAccount.has(accountEmail)) {
        byAccount.set(accountEmail, {
          accountEmail,
          coldSends: [],
          followups: [],
          crmClients: [],
        });
      }
      return byAccount.get(accountEmail);
    }

    for (const addr of lead.sentBy || []) {
      ensureAccount(addr);
    }

    for (const row of marketingRows) {
      const accountEmail = row.assignment?.email?.address || null;
      const bucket = ensureAccount(accountEmail);
      const event = {
        id: row.id,
        type: 'cold',
        sendStatus: row.sendStatus,
        subject: row.subject,
        sentAt: row.sentAt,
        createdAt: row.createdAt,
        errorMessage: row.errorMessage,
        nylasMessageId: row.nylasMessageId,
        assignmentDate: row.assignment?.assignmentDate || null,
        accountEmail: accountEmail ? String(accountEmail).toLowerCase() : null,
      };
      if (bucket) bucket.coldSends.push(event);
    }

    for (const row of followupRows) {
      const accountEmail = row.assignment?.email?.address || null;
      const bucket = ensureAccount(accountEmail);
      const event = {
        id: row.id,
        type: 'followup',
        sendStatus: row.sendStatus,
        subject: row.subject,
        originalSubject: row.originalSubject,
        sentAt: row.sentAt,
        createdAt: row.createdAt,
        errorMessage: row.errorMessage,
        nylasMessageId: row.nylasMessageId,
        assignmentDate: row.assignment?.assignmentDate || null,
        accountEmail: accountEmail ? String(accountEmail).toLowerCase() : null,
      };
      if (bucket) bucket.followups.push(event);
    }

    for (const crm of crmRows) {
      const bucket = ensureAccount(crm.sentByAccount);
      const serialized = serializeCrmClient(crm);
      if (bucket) bucket.crmClients.push(serialized);
      else {
        // CRM without mailbox — still surface under a placeholder bucket
        const orphanKey = '__unassigned__';
        if (!byAccount.has(orphanKey)) {
          byAccount.set(orphanKey, {
            accountEmail: null,
            coldSends: [],
            followups: [],
            crmClients: [],
          });
        }
        byAccount.get(orphanKey).crmClients.push(serialized);
      }
    }

    const accounts = Array.from(byAccount.values()).map((bucket) => {
      const latestCold = bucket.coldSends[0] || null;
      const latestFollowup = bucket.followups[0] || null;
      let flowStatus = 'not_contacted';
      if (latestFollowup && (latestFollowup.sendStatus === 'sent' || latestFollowup.sentAt)) {
        flowStatus = 'followed_up';
      } else if (latestCold && (latestCold.sendStatus === 'sent' || latestCold.sentAt)) {
        flowStatus = 'sent';
      } else if (latestCold || latestFollowup) {
        flowStatus = latestCold?.sendStatus || latestFollowup?.sendStatus || 'pending';
      } else if (bucket.crmClients.length > 0) {
        flowStatus = 'crm_only';
      }

      return {
        accountEmail: bucket.accountEmail,
        flowStatus,
        leadStatus: lead.status || 'new',
        isSentOnLead: Array.isArray(lead.sentBy)
          ? lead.sentBy.some((a) => String(a).toLowerCase() === bucket.accountEmail)
          : false,
        coldSends: bucket.coldSends,
        followups: bucket.followups,
        crmClients: bucket.crmClients,
      };
    });

    // Prefer real accounts first; unassigned CRM last
    accounts.sort((a, b) => {
      if (!a.accountEmail && b.accountEmail) return 1;
      if (a.accountEmail && !b.accountEmail) return -1;
      return String(a.accountEmail || '').localeCompare(String(b.accountEmail || ''));
    });

    let leadFilter = null;
    if (lead.leadFilterId) {
      leadFilter = await AppDataSource.getRepository(LeadFilter).findOne({
        where: { id: lead.leadFilterId },
      });
    }

    res.json({
      lead: serializeClientLeadForApi(lead),
      leadFilter,
      accounts,
    });
  } catch (error) {
    console.error('Get lead history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function bulkDeleteLeads(req, res) {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'IDs array is required' });
    }

    const clientRepository = AppDataSource.getRepository(Client);
    
    // Soft delete by setting deletedAt
    const result = await clientRepository
      .createQueryBuilder()
      .update(Client)
      .set({ deletedAt: new Date() })
      .where('id IN (:...ids)', { ids })
      .andWhere('deletedAt IS NULL')
      .execute();

    res.json({
      success: true,
      deleted: result.affected || 0,
    });
  } catch (error) {
    console.error('Bulk delete leads error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getUncontactedLeads(req, res) {
  try {
    const count = parseInt(req.query.count) || 100;
    const leadFilterId = req.query.leadFilterId;
    const leadFilterMode = req.query.leadFilterMode || 'include'; // 'include' or 'exclude'
    const location = req.query.location;
    const industry = req.query.industry;
    const verifiedOnly = req.query.verifiedOnly !== 'false'; // default true: only verified (good/risky); false = include unverified
    const excludeClientIds = req.query.excludeClientIds
      ? String(req.query.excludeClientIds)
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : [];

    const leads = await fetchUncontactedVerifiedLeads({
      count,
      verifiedOnly,
      leadFilterId,
      leadFilterMode,
      location,
      industry,
      excludeClientIds,
    });

    console.log('[getUncontactedLeads] Found', leads.length, 'leads. Filter mode:', leadFilterMode, 'Filter ID:', leadFilterId);

    const formattedLeads = leads.map(formatUncontactedLeadForExtension);

    const meta = {
      total: formattedLeads.length,
      count: formattedLeads.length,
    };

    if (!formattedLeads.length) {
      const pool = await getUncontactedPoolStats({
        verifiedOnly,
        leadFilterId,
        leadFilterMode,
        location,
        industry,
        excludeClientIds,
      });
      meta.pool = pool;
      if (pool.available === 0 && pool.blockedByPendingMarketing > 0) {
        meta.reason =
          'All verified new leads are already assigned to Marketing outreach (pending). Unassign or send them first.';
      } else if (pool.available === 0 && verifiedOnly) {
        meta.reason = 'No Millions-verified (good/risky) new leads available. Try verifiedOnly=false or verify more leads.';
      }
    }

    res.json({
      data: formattedLeads,
      meta,
    });
  } catch (error) {
    console.error('Get uncontacted leads error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getLeadFilters(req, res) {
  try {
    const leadFilterRepository = AppDataSource.getRepository(LeadFilter);
    const filters = await leadFilterRepository.find({
      order: { createdAt: 'DESC' },
    });

    res.json({
      data: filters,
    });
  } catch (error) {
    console.error('Get lead filters error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function markClientAsFollowedUp(req, res) {
  try {
    const { email, sentBy } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const clientRepository = AppDataSource.getRepository(Client);
    
    // Find the client by email
    const client = await clientRepository.findOne({
      where: { email: email, deletedAt: null },
    });

    if (!client) {
      return res.status(404).json({ error: 'Client not found with the provided email' });
    }

    const updateData = {
      isFollowup: true,
      status: 'followedup',
      lastSent: new Date(),
    };

    if (sentBy) {
      const currentSentBy = client.sentBy || [];
      if (!currentSentBy.includes(sentBy)) {
        updateData.sentBy = [...currentSentBy, sentBy];
      }
    }

    await clientRepository.update({ id: client.id }, updateData);

    // Return updated client
    const updatedClient = await clientRepository.findOne({
      where: { id: client.id },
    });

    return res.json({ message: 'Client marked as followed up', data: serializeClientLeadForApi(updatedClient) });
  } catch (error) {
    console.error('Error marking client as followed up:', error);
    return res.status(500).json({ error: 'Failed to mark client as followed up' });
  }
}

export async function markClientAsSent(req, res) {
  try {
    const { clientId } = req.params;
    const { sentBy, status } = req.body;

    if (!clientId) {
      return res.status(400).json({ error: 'Client ID is required' });
    }

    const clientRepository = AppDataSource.getRepository(Client);
    
    // Find the client
    const client = await clientRepository.findOne({
      where: { id: clientId, deletedAt: null },
    });

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Prepare update data
    const updateData = {
      isSent: true,
      lastSent: new Date(),
    };

    // Update sentBy - append to existing array or create new array
    if (sentBy) {
      const currentSentBy = client.sentBy || [];
      // Only add if not already in the array
      if (!currentSentBy.includes(sentBy)) {
        updateData.sentBy = [...currentSentBy, sentBy];
      } else {
        updateData.sentBy = currentSentBy;
      }
    }

    // Update status if provided, otherwise default to 'used'
    if (status) {
      updateData.status = status;
    } else {
      updateData.status = 'used';
    }

    // Update the client
    await clientRepository.update({ id: clientId }, updateData);

    // Return updated client
    const updatedClient = await clientRepository.findOne({
      where: { id: clientId },
    });

    res.json({
      success: true,
      data: serializeClientLeadForApi(updatedClient),
    });
  } catch (error) {
    console.error('Mark client as sent error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function bulkUpdateLeads(req, res) {
  try {
    const { ids, updates } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'IDs array is required' });
    }

    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'Updates object is required' });
    }

    // Only allow updating specific fields
    const allowedFields = ['status', 'isSent', 'isReplied', 'lastSent', 'contactedBy', 'templateIndustry'];
    const updateData = {};
    
    for (const field of allowedFields) {
      if (field in updates && updates[field] !== undefined) {
        if (field === 'lastSent') {
          // Convert date string to Date object
          updateData[field] = updates[field] ? new Date(updates[field]) : null;
        } else if (field === 'contactedBy') {
          // Handle array field - if it's a string (single user ID), convert to array
          // If it's null, set to null, otherwise ensure it's an array
          if (updates[field] === null || updates[field] === '') {
            updateData[field] = null;
          } else if (typeof updates[field] === 'string') {
            updateData[field] = [updates[field]];
          } else if (Array.isArray(updates[field])) {
            updateData[field] = updates[field];
          } else {
            updateData[field] = null;
          }
        } else if (field === 'templateIndustry') {
          const raw = updates[field];
          if (raw === null || raw === '') {
            updateData[field] = null;
          } else {
            updateData[field] = String(raw).trim() || null;
          }
        } else {
          updateData[field] = updates[field];
        }
      }
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const clientRepository = AppDataSource.getRepository(Client);
    
    const result = await clientRepository
      .createQueryBuilder()
      .update(Client)
      .set(updateData)
      .where('id IN (:...ids)', { ids })
      .andWhere('deletedAt IS NULL')
      .execute();

    res.json({
      success: true,
      updated: result.affected || 0,
    });
  } catch (error) {
    console.error('Bulk update leads error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function checkLeadsStatus(req, res) {
  try {
    const { emails } = req.body;

    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'Emails array is required' });
    }

    const clientRepository = AppDataSource.getRepository(Client);
    
    // Find all clients with the provided emails
    const clients = await clientRepository
      .createQueryBuilder('client')
      .where('client.email IN (:...emails)', { emails: emails.map(e => e.toLowerCase()) })
      .andWhere('client.deletedAt IS NULL')
      .getMany();

    // Map clients by email for easy lookup
    const clientsMap = new Map();
    clients.forEach((client) => {
      const row = serializeClientLeadForApi(client);
      clientsMap.set(client.email.toLowerCase(), {
        id: row.id,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        companyName: row.companyName,
        status: client.status,
        isSent: client.isSent,
        isReplied: client.isReplied,
        lastSent: client.lastSent,
      });
    });

    // Return status for all requested emails (including those not found)
    const results = emails.map(email => {
      const client = clientsMap.get(email.toLowerCase());
      if (client) {
        return {
          email: email,
          found: true,
          ...client,
        };
      } else {
        return {
          email: email,
          found: false,
        };
      }
    });

    res.json({
      success: true,
      data: results,
    });
  } catch (error) {
    console.error('Check leads status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getDashboardKPIs(req, res) {
  try {
    const clientRepository = AppDataSource.getRepository(Client);
    
    // Get today's date range (start and end of today)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    // Get this week's date range (start of week to end of today)
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay()); // Start of week (Sunday)
    weekStart.setHours(0, 0, 0, 0);
    
    // Get this month's date range (start of month to end of today)
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    monthStart.setHours(0, 0, 0, 0);
    
    // Count outbound emails (Nylas marketing sends + Gmail extension sends)
    const emailsSentToday = await countOutboundEmailsInRange(today, tomorrow);
    const emailsSentThisWeek = await countOutboundEmailsInRange(weekStart, tomorrow);
    const emailsSentThisMonth = await countOutboundEmailsInRange(monthStart, tomorrow);
    
    // Count follow-up emails sent today (isFollowup = true AND lastSent is today)
    const followUpEmailsToday = await clientRepository
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL')
      .andWhere('client.isFollowup = :isFollowup', { isFollowup: true })
      .andWhere('client.lastSent >= :today', { today })
      .andWhere('client.lastSent < :tomorrow', { tomorrow })
      .getCount();
    
    // Count clients who replied (isReplied = true)
    // We'll count replies that happened today (updatedAt is today)
    const clientsRepliedToday = await clientRepository
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL')
      .andWhere('client.isReplied = :isReplied', { isReplied: true })
      .andWhere('client.updatedAt >= :today', { today })
      .andWhere('client.updatedAt < :tomorrow', { tomorrow })
      .getCount();
    
    // Count meetings scheduled (check status or note field)
    // Assuming meetings might be tracked in status field or note contains "meeting"
    // We'll check for status that might indicate meeting, or note containing meeting keywords
    const meetingsScheduledToday = await clientRepository
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL')
      .andWhere(
        '(client.status ILIKE :meetingStatus OR client.note ILIKE :meetingNote)',
        { 
          meetingStatus: '%meeting%',
          meetingNote: '%meeting%'
        }
      )
      .andWhere('client.updatedAt >= :today', { today })
      .andWhere('client.updatedAt < :tomorrow', { tomorrow })
      .getCount();
    
    res.json({
      success: true,
      data: {
        emailsSentToday,
        emailsSentThisWeek,
        emailsSentThisMonth,
        followUpEmailsToday,
        clientsRepliedToday,
        meetingsScheduledToday,
      },
    });
  } catch (error) {
    console.error('Get dashboard KPIs error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Get emails sent in a date range
export async function getEmailsSentInDateRange(req, res) {
  try {
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate query parameters are required' });
    }
    
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD format' });
    }
    
    if (start > end) {
      return res.status(400).json({ error: 'startDate must be before or equal to endDate' });
    }
    
    const endExclusive = new Date(end);
    endExclusive.setMilliseconds(endExclusive.getMilliseconds() + 1);

    const emailsSent = await countOutboundEmailsInRange(start, endExclusive);
    
    res.json({
      success: true,
      data: {
        emailsSent,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      },
    });
  } catch (error) {
    console.error('Get emails sent in date range error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function resetLeadsStatus(req, res) {
  try {
    const { leadIds } = req.body;

    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({ error: 'Lead IDs array is required' });
    }

    const reset = await resetLeadsFromReady(leadIds);

    res.json({
      success: true,
      reset,
    });
  } catch (error) {
    console.error('Reset leads status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// In-memory storage for verification job status
const verificationJobs = new Map();
// In-memory storage for Apollo LinkedIn email-fetch jobs
const apolloFetchJobs = new Map();

function parseIncludeErrorFlag(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function parseLeadFilterOptions(source) {
  if (!source) return { leadFilterIds: [], leadFilterMode: 'include' };
  let ids = source.leadFilterIds;
  if (typeof ids === 'string') {
    ids = ids.split(',').map((id) => id.trim()).filter(Boolean);
  } else if (Array.isArray(ids)) {
    ids = ids.map((id) => String(id).trim()).filter(Boolean);
  } else {
    ids = [];
  }
  const leadFilterMode = source.leadFilterMode === 'exclude' ? 'exclude' : 'include';
  return { leadFilterIds: ids, leadFilterMode };
}

function isNewLeadEligibleForMillionsVerify(client, includeError = false) {
  if (!client.email || String(client.email).trim() === '') return false;
  const millionsStatus = client.millionsStatus
    ? String(client.millionsStatus).trim().toLowerCase()
    : '';
  if (!millionsStatus) return true;
  return includeError && millionsStatus === 'error';
}

async function fetchNewLeadsForVerification(
  clientRepository,
  { leadFilterIds = [], leadFilterMode = 'include' } = {}
) {
  const qb = clientRepository
    .createQueryBuilder('client')
    .where('client.deletedAt IS NULL')
    .andWhere('(client.status = :status OR client.status IS NULL)', { status: 'new' });

  if (leadFilterIds.length > 0) {
    if (leadFilterMode === 'exclude') {
      qb.andWhere(
        '(client.leadFilterId IS NULL OR client.leadFilterId NOT IN (:...leadFilterIds))',
        { leadFilterIds }
      );
    } else {
      qb.andWhere('client.leadFilterId IN (:...leadFilterIds)', { leadFilterIds });
    }
  }

  return qb.orderBy('client.createdAt', 'ASC').getMany();
}

function summarizeNewLeadsVerification(clients, includeError = false) {
  const clientsToVerify = clients.filter((client) =>
    isNewLeadEligibleForMillionsVerify(client, includeError)
  );
  const unverifiedCount = clients.filter((client) =>
    isNewLeadEligibleForMillionsVerify(client, false)
  ).length;
  const errorCount = clients.filter((client) => {
    if (!client.email || String(client.email).trim() === '') return false;
    return String(client.millionsStatus || '').trim().toLowerCase() === 'error';
  }).length;

  return {
    clientsToVerify,
    count: clientsToVerify.length,
    totalNew: clients.length,
    alreadyVerified: clients.length - clientsToVerify.length,
    unverifiedCount,
    errorCount,
  };
}

/**
 * Start bulk email verification with Millions API
 */
export async function bulkVerifyEmails(req, res) {
  try {
    // Debug logging
    console.log('bulkVerifyEmails - Request body:', req.body);
    console.log('bulkVerifyEmails - Request body type:', typeof req.body);
    console.log('bulkVerifyEmails - Content-Type:', req.get('Content-Type'));
    
    // Check if body exists
    if (!req.body) {
      return res.status(400).json({ 
        error: 'Request body is missing',
        hint: 'Make sure to send JSON with Content-Type: application/json header'
      });
    }
    
    // Handle case where body might be a string (shouldn't happen with express.json(), but just in case)
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (parseError) {
        console.error('Error parsing body as JSON:', parseError);
        return res.status(400).json({ 
          error: 'Invalid JSON in request body', 
          details: parseError.message,
          hint: 'Ensure the request body is valid JSON and Content-Type header is set to application/json'
        });
      }
    }
    
    const { clientIds } = body;
    
    if (!clientIds) {
      return res.status(400).json({ error: 'clientIds is required in request body' });
    }
    
    if (!Array.isArray(clientIds)) {
      return res.status(400).json({ error: 'clientIds must be an array' });
    }
    
    if (clientIds.length === 0) {
      return res.status(400).json({ error: 'clientIds array cannot be empty' });
    }

    const apiKey = process.env.MILLIONS_API_KEY;
    if (!apiKey) {
      // Return a proper error even if API key is missing
      return res.status(400).json({ 
        error: 'MILLIONS_API_KEY environment variable is not set',
        message: 'Please configure the Millions API key in your environment variables'
      });
    }

    const clientRepository = AppDataSource.getRepository(Client);
    
    // Fetch clients with emails, excluding those already verified
    const clients = await clientRepository.find({
      where: {
        id: In(clientIds),
        deletedAt: null,
      },
    });

    // Filter out clients without emails or already verified (exclude those with 'good' or 'risky' status)
    const clientsToVerify = clients.filter(client => {
      return client.email && 
             client.email.trim() !== '' && 
             (!client.millionsStatus || client.millionsStatus === 'bad' || client.millionsStatus === 'error');
    });

    if (clientsToVerify.length === 0) {
      return res.status(400).json({ error: 'No valid emails to verify' });
    }

    const emails = clientsToVerify.map(c => c.email);
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Initialize job status
    verificationJobs.set(jobId, {
      jobId,
      status: 'processing',
      total: emails.length,
      completed: 0,
      results: [],
      startTime: new Date(),
    });

    // Start verification in background
    (async () => {
      try {
        await verifyEmailsBulk(
          emails,
          apiKey,
          async (email, result, index, total) => {
            // Find the client for this email
            const client = clientsToVerify.find(c => c.email === email);
            if (client) {
              // Update client in database
              await clientRepository.update(
                { id: client.id },
                { millionsStatus: result.status }
              ).catch(err => console.error(`Error updating client ${client.id}:`, err));

              // Update job status
              const job = verificationJobs.get(jobId);
              if (job) {
                job.completed = index;
                job.results.push({
                  clientId: client.id,
                  email: email,
                  status: result.status,
                  result: result.result,
                  error: result.error,
                });
              }
            }
          }
        );

        // Mark job as completed
        const job = verificationJobs.get(jobId);
        if (job) {
          job.status = 'completed';
          job.completed = job.total;
          job.endTime = new Date();
        }
      } catch (error) {
        console.error('Verification job error:', error);
        const job = verificationJobs.get(jobId);
        if (job) {
          job.status = 'error';
          job.error = error.message;
          job.endTime = new Date();
        }
      }
    })();

    res.json({
      success: true,
      jobId,
      total: emails.length,
      message: 'Verification started',
    });
  } catch (error) {
    console.error('Bulk verify emails error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

/**
 * Verify all leads with status "new"
 */
export async function bulkVerifyAllNew(req, res) {
  try {
    const apiKey = process.env.MILLIONS_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ 
        error: 'MILLIONS_API_KEY environment variable is not set',
        message: 'Please configure the Millions API key in your environment variables'
      });
    }

    const includeError = parseIncludeErrorFlag(req.body?.includeError);
    const { leadFilterIds, leadFilterMode } = parseLeadFilterOptions(req.body);
    const limitRaw = req.body?.limit ?? req.body?.amount;
    let limit = null;
    if (limitRaw != null && String(limitRaw).trim() !== '' && String(limitRaw).toLowerCase() !== 'all') {
      const n = parseInt(String(limitRaw), 10);
      if (!Number.isFinite(n) || n < 1) {
        return res.status(400).json({ error: 'limit must be a positive integer' });
      }
      limit = Math.min(100000, n);
    }

    const clientRepository = AppDataSource.getRepository(Client);
    const clients = await fetchNewLeadsForVerification(clientRepository, {
      leadFilterIds,
      leadFilterMode,
    });
    const { clientsToVerify: allEligible } = summarizeNewLeadsVerification(clients, includeError);
    const clientsToVerify =
      limit != null ? allEligible.slice(0, limit) : allEligible;

    if (clientsToVerify.length === 0) {
      const errorMessage = includeError
        ? 'No valid emails to verify. All "new" status leads are either missing emails, already verified, or have no error status to retry.'
        : 'No valid emails to verify. All "new" status leads are either missing emails or already verified.';
      return res.status(400).json({ error: errorMessage });
    }

    const emails = clientsToVerify.map(c => c.email);
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Initialize job status
    verificationJobs.set(jobId, {
      jobId,
      status: 'processing',
      total: emails.length,
      completed: 0,
      results: [],
      startTime: new Date(),
    });

    // Start verification in background
    (async () => {
      try {
        await verifyEmailsBulk(
          emails,
          apiKey,
          async (email, result, index, total) => {
            // Find the client for this email
            const client = clientsToVerify.find(c => c.email === email);
            if (client) {
              // Update client in database
              await clientRepository.update(
                { id: client.id },
                { millionsStatus: result.status }
              ).catch(err => console.error(`Error updating client ${client.id}:`, err));

              // Update job status
              const job = verificationJobs.get(jobId);
              if (job) {
                job.completed = index;
                job.results.push({
                  clientId: client.id,
                  email: email,
                  status: result.status,
                  result: result.result,
                  error: result.error,
                });
              }
            }
          }
        );

        // Mark job as completed
        const job = verificationJobs.get(jobId);
        if (job) {
          job.status = 'completed';
          job.completed = job.total;
          job.endTime = new Date();
        }
      } catch (error) {
        console.error('Verification job error:', error);
        const job = verificationJobs.get(jobId);
        if (job) {
          job.status = 'error';
          job.error = error.message;
          job.endTime = new Date();
        }
      }
    })();

    res.json({
      success: true,
      jobId,
      total: emails.length,
      available: allEligible.length,
      limit: limit,
      includeError,
      leadFilterIds,
      leadFilterMode,
      message: includeError
        ? `Verification started for ${emails.length} "new" lead(s) (including error status retries)`
        : `Verification started for ${emails.length} "new" lead(s)`,
    });
  } catch (error) {
    console.error('Bulk verify all new error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

/**
 * Get count of new leads that can be verified
 */
export async function getNewLeadsVerificationCount(req, res) {
  try {
    const includeError = parseIncludeErrorFlag(req.query.includeError);
    const { leadFilterIds, leadFilterMode } = parseLeadFilterOptions(req.query);
    const clientRepository = AppDataSource.getRepository(Client);
    const clients = await fetchNewLeadsForVerification(clientRepository, {
      leadFilterIds,
      leadFilterMode,
    });
    const summary = summarizeNewLeadsVerification(clients, includeError);

    res.json({
      count: summary.count,
      totalNew: summary.totalNew,
      alreadyVerified: summary.alreadyVerified,
      unverifiedCount: summary.unverifiedCount,
      errorCount: summary.errorCount,
      includeError,
      leadFilterIds,
      leadFilterMode,
    });
  } catch (error) {
    console.error('Get new leads verification count error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Get verification job status
 */
export async function getVerificationStatus(req, res) {
  try {
    const { jobId } = req.params;
    
    if (!jobId) {
      return res.status(400).json({ error: 'jobId is required' });
    }

    const job = verificationJobs.get(jobId);
    
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json(job);
  } catch (error) {
    console.error('Get verification status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Count Apollo-sourced leads that have LinkedIn but no email (ready for enrichment).
 * Excludes leads already checked by Apollo (no_email / email_conflict / error / updated).
 */
export async function getApolloMissingEmailCount(req, res) {
  try {
    const rawIds = req.query?.ids ?? req.body?.ids;
    const ids = Array.isArray(rawIds)
      ? rawIds.map((id) => String(id).trim()).filter(Boolean)
      : typeof rawIds === 'string' && rawIds.trim()
        ? rawIds.split(',').map((s) => s.trim()).filter(Boolean)
        : null;

    const clientRepository = AppDataSource.getRepository(Client);

    const baseQb = () => {
      const qb = clientRepository
        .createQueryBuilder('client')
        .leftJoin(LeadFilter, 'lf', 'lf.id = client.leadFilterId')
        .where('client.deletedAt IS NULL')
        .andWhere("(client.email IS NULL OR TRIM(client.email) = '')")
        .andWhere('client.linkedin IS NOT NULL')
        .andWhere("TRIM(client.linkedin) <> ''");
      if (ids?.length) {
        qb.andWhere('client.id IN (:...ids)', { ids });
      } else {
        qb.andWhere("LOWER(TRIM(COALESCE(lf.tool, ''))) = 'apollo'");
      }
      return qb;
    };

    const [noEmailWithLinkedin, eligible, noEmailStatus, conflictStatus] = await Promise.all([
      baseQb().getCount(),
      baseQb()
        .andWhere("(client.apollo_email_status IS NULL OR TRIM(client.apollo_email_status) = '')")
        .getCount(),
      baseQb().andWhere("client.apollo_email_status = 'no_email'").getCount(),
      baseQb().andWhere("client.apollo_email_status = 'email_conflict'").getCount(),
    ]);

    const alreadyChecked = Math.max(0, noEmailWithLinkedin - eligible);

    return res.json({
      count: eligible,
      eligible,
      forceCount: noEmailWithLinkedin,
      noEmailWithLinkedin,
      alreadyChecked,
      noEmail: noEmailStatus,
      emailConflict: conflictStatus,
    });
  } catch (error) {
    console.error('getApolloMissingEmailCount error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Start async Apollo LinkedIn email enrichment job (progress via status endpoint).
 */
export async function fetchApolloEmails(req, res) {
  try {
    const apolloAccountId = String(req.body?.apolloAccountId || req.body?.apollo_account_id || '').trim();
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map((id) => String(id).trim()).filter(Boolean)
      : null;
    const force =
      req.body?.force === true ||
      req.body?.force === 1 ||
      String(req.body?.force || '').trim().toLowerCase() === 'true';

    // limit: 'all' | omitted → process every eligible lead.
    // Numeric limit kept for optional throttling (hard cap 50k).
    const limitRaw = req.body?.limit;
    const wantAll =
      limitRaw == null ||
      limitRaw === '' ||
      String(limitRaw).toLowerCase() === 'all' ||
      limitRaw === 0 ||
      limitRaw === '0';
    const limitNum = wantAll
      ? null
      : Math.min(50000, Math.max(1, parseInt(String(limitRaw), 10) || 0)) || null;

    if (!apolloAccountId) {
      return res.status(400).json({ error: 'apolloAccountId is required' });
    }

    const apolloRepo = AppDataSource.getRepository(ApolloAccount);
    const account = await apolloRepo.findOne({ where: { id: apolloAccountId } });
    if (!account || account.deletedAt) {
      return res.status(404).json({ error: 'Apollo account not found' });
    }
    if (!String(account.apiKey || '').trim()) {
      return res.status(400).json({ error: 'Apollo account is missing an API key' });
    }

    const clientRepository = AppDataSource.getRepository(Client);
    const qb = clientRepository
      .createQueryBuilder('client')
      .leftJoin(LeadFilter, 'lf', 'lf.id = client.leadFilterId')
      .where('client.deletedAt IS NULL')
      .andWhere("(client.email IS NULL OR TRIM(client.email) = '')")
      .andWhere('client.linkedin IS NOT NULL')
      .andWhere("TRIM(client.linkedin) <> ''");

    if (force) {
      qb.andWhere(
        `(client.apollo_email_status IS NULL OR TRIM(client.apollo_email_status) = ''
          OR client.apollo_email_status IN ('no_email', 'email_conflict', 'error'))`
      );
    } else {
      qb.andWhere("(client.apollo_email_status IS NULL OR TRIM(client.apollo_email_status) = '')");
    }

    if (ids?.length) {
      qb.andWhere('client.id IN (:...ids)', { ids });
    } else {
      qb.andWhere("LOWER(TRIM(COALESCE(lf.tool, ''))) = 'apollo'");
    }

    if (force) {
      qb.orderBy('client.apolloEmailCheckedAt', 'ASC', 'NULLS FIRST');
      qb.addOrderBy('client.createdAt', 'ASC');
    } else {
      qb.orderBy('client.createdAt', 'ASC');
    }
    if (limitNum != null) {
      qb.take(limitNum);
    }

    const leads = await qb.getMany();

    const jobId = `apollo-fetch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    apolloFetchJobs.set(jobId, {
      status: 'running',
      total: leads.length,
      completed: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      results: [],
      error: null,
      startedAt: new Date().toISOString(),
    });

    if (!leads.length) {
      const job = apolloFetchJobs.get(jobId);
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      return res.json({
        success: true,
        jobId,
        total: 0,
        message: 'No eligible leads to enrich',
      });
    }

    // Run enrichment in background so FE can poll progress
    setImmediate(() => {
      void (async () => {
        const job = apolloFetchJobs.get(jobId);
        if (!job) return;

        try {
          const enrichInput = leads.map((lead) => ({
            id: lead.id,
            linkedin: lead.linkedin,
            firstName: lead.firstName,
            lastName: lead.lastName,
            companyName: lead.companyName,
            companyUrl: lead.companyUrl,
          }));

          await bulkEnrichPeopleByLinkedIn(account.apiKey, enrichInput, {
            onBatch: async ({ processed, total, batchResults }) => {
              const checkedAt = new Date();
              for (const item of batchResults) {
                const lead = leads.find((l) => l.id === item.id);
                if (!lead) {
                  job.failed += 1;
                  job.results.push({
                    id: item.id,
                    status: 'failed',
                    error: 'Lead not found after enrich',
                  });
                  continue;
                }

                if (!item.email) {
                  await clientRepository.update(
                    { id: lead.id },
                    {
                      apolloEmailStatus: 'no_email',
                      apolloSuggestedEmail: null,
                      apolloEmailCheckedAt: checkedAt,
                      linkedin: normalizeLinkedInUrl(lead.linkedin) || lead.linkedin,
                    }
                  );
                  job.skipped += 1;
                  job.results.push({
                    id: lead.id,
                    linkedin: lead.linkedin,
                    status: 'no_email',
                  });
                  continue;
                }

                const emailOwner = await clientRepository.findOne({
                  where: { email: item.email, deletedAt: null },
                });
                if (emailOwner && emailOwner.id !== lead.id) {
                  await clientRepository.update(
                    { id: lead.id },
                    {
                      apolloEmailStatus: 'email_conflict',
                      apolloSuggestedEmail: item.email,
                      apolloEmailCheckedAt: checkedAt,
                      linkedin: normalizeLinkedInUrl(lead.linkedin) || lead.linkedin,
                    }
                  );
                  job.failed += 1;
                  job.results.push({
                    id: lead.id,
                    linkedin: lead.linkedin,
                    email: item.email,
                    status: 'email_conflict',
                    error: 'Email already belongs to another lead',
                  });
                  continue;
                }

                await clientRepository.update(
                  { id: lead.id },
                  {
                    email: item.email,
                    linkedin: normalizeLinkedInUrl(lead.linkedin) || lead.linkedin,
                    apolloEmailStatus: 'updated',
                    apolloSuggestedEmail: null,
                    apolloEmailCheckedAt: checkedAt,
                  }
                );
                job.updated += 1;
                job.results.push({
                  id: lead.id,
                  linkedin: lead.linkedin,
                  email: item.email,
                  status: 'updated',
                });
              }

              job.completed = processed;
              job.total = total;
            },
          });

          job.status = 'completed';
          job.completed = job.total;
          job.completedAt = new Date().toISOString();
        } catch (error) {
          console.error('Apollo fetch job error:', error);
          job.status = 'error';
          job.error = error.message || 'Apollo fetch failed';
          job.completedAt = new Date().toISOString();
        }
      })();
    });

    return res.json({
      success: true,
      jobId,
      total: leads.length,
      message: `Started fetching emails for ${leads.length} lead(s)${force ? ' (force re-check)' : ''}`,
    });
  } catch (error) {
    console.error('fetchApolloEmails error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

export async function getApolloFetchStatus(req, res) {
  try {
    const { jobId } = req.params;
    if (!jobId) {
      return res.status(400).json({ error: 'jobId is required' });
    }
    const job = apolloFetchJobs.get(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    return res.json(job);
  } catch (error) {
    console.error('getApolloFetchStatus error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

