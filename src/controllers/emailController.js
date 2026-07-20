import { AppDataSource } from '../config/database.js';
import { Email } from '../entities/Email.js';
import { Client } from '../entities/Client.js';
import { CrmClient } from '../entities/CrmClient.js';
import { serializeCrmClient } from './crmClientController.js';
import fs from 'fs/promises';
import XLSX from 'xlsx';
import { sleep } from '../utils/nylasRateLimit.js';
import { probeNylasGrantMessagesList } from '../services/nylasGrantProbeService.js';
import { lookupRecipientsByEmails, sendEmailFromMailbox } from '../services/emailComposeService.js';

function normalizeEmailAddress(value) {
  return String(value || '').trim().toLowerCase();
}

async function findActiveEmailByAddress(emailRepository, address) {
  const normalized = normalizeEmailAddress(address);
  if (!normalized) return null;
  return emailRepository
    .createQueryBuilder('email')
    .where('LOWER(TRIM(email.address)) = :address', { address: normalized })
    .andWhere('email.deletedAt IS NULL')
    .getOne();
}

async function findSoftDeletedEmailByAddress(emailRepository, address) {
  const normalized = normalizeEmailAddress(address);
  if (!normalized) return null;
  return emailRepository
    .createQueryBuilder('email')
    .where('LOWER(TRIM(email.address)) = :address', { address: normalized })
    .andWhere('email.deletedAt IS NOT NULL')
    .orderBy('email.deletedAt', 'DESC')
    .getOne();
}

const VALID_EMAIL_STATUSES = ['new', 'good', 'bad', 'blocked', 'warmingup'];

function applyEmailListFilters(queryBuilder, query) {
  const includeDeleted =
    query.includeDeleted === 'true' || query.includeDeleted === '1';

  if (!includeDeleted) {
    queryBuilder.where('email.deletedAt IS NULL');
  }

  const exactAddress = normalizeEmailAddress(query.address || '');
  if (exactAddress) {
    queryBuilder.andWhere('LOWER(TRIM(email.address)) = :exactAddress', {
      exactAddress,
    });
  } else if (query.search) {
    queryBuilder.andWhere('email.address ILIKE :search', { search: `%${query.search}%` });
  }

  const status = String(query.status || '').trim().toLowerCase();
  if (status && VALID_EMAIL_STATUSES.includes(status)) {
    queryBuilder.andWhere('email.status = :status', { status });
  }
}

function buildEmailPayloadFromBody(body, emailAddress) {
  const rawGmailUIndex = body.gmailUIndex ?? body.gmail_u_index;
  const parsedGmailUIndex =
    rawGmailUIndex === '' || rawGmailUIndex === null || rawGmailUIndex === undefined
      ? null
      : Number.parseInt(String(rawGmailUIndex), 10);

  const rawMarketingDailyLimit = body.marketingDailyLimit ?? body.marketing_daily_limit;
  const parsedMarketingDailyLimit =
    rawMarketingDailyLimit === '' ||
    rawMarketingDailyLimit === null ||
    rawMarketingDailyLimit === undefined
      ? null
      : Number.parseInt(String(rawMarketingDailyLimit), 10);

  return {
    address: emailAddress,
    firstName: body.firstName || body.first_name || null,
    lastName: body.lastName || body.last_name || null,
    marketingDailyLimit:
      Number.isNaN(parsedMarketingDailyLimit) || parsedMarketingDailyLimit <= 0
        ? null
        : parsedMarketingDailyLimit,
    accountId: body.accountId || null,
    status: body.status || 'new',
    password: body.password || null,
    appPassword: body.appPassword || body.app_password || null,
    twoFa: body.twoFa || body['2fa'] || null,
    recoveryEmail: body.recoveryEmail || null,
    grantId: body.grantId || body.grant_id || null,
    nylasKey: body.nylasKey || body.nylas_key || null,
    chromePath: body.chromePath || body.chrome_path || null,
    chromeUserDataDir: body.chromeUserDataDir || body.chrome_user_data_dir || null,
    chromeProfileDirectory: body.chromeProfileDirectory || body.chrome_profile_directory || null,
    gmailUIndex: Number.isNaN(parsedGmailUIndex) ? null : parsedGmailUIndex,
  };
}

export async function getEmailById(req, res) {
  try {
    const emailRepository = AppDataSource.getRepository(Email);
    const email = await emailRepository.findOne({
      where: { id: req.params.id, deletedAt: null },
      relations: ['account'],
    });
    if (!email) {
      return res.status(404).json({ error: 'Email not found' });
    }
    res.json(email);
  } catch (error) {
    console.error('Get email by id error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Mailbox detail: email record, leads sent from this address (with lastSent), CRM clients linked to it.
 */
export async function getEmailDetail(req, res) {
  try {
    const emailRepository = AppDataSource.getRepository(Email);
    const email = await emailRepository.findOne({
      where: { id: req.params.id, deletedAt: null },
      relations: ['account'],
    });
    if (!email) {
      return res.status(404).json({ error: 'Email not found' });
    }

    const mailbox = normalizeEmailAddress(email.address);
    const sentLimit = Math.min(500, Math.max(1, parseInt(String(req.query.sentLimit || '200'), 10) || 200));
    const crmLimit = Math.min(500, Math.max(1, parseInt(String(req.query.crmLimit || '200'), 10) || 200));

    const clientRepository = AppDataSource.getRepository(Client);
    const sentLeads = await clientRepository
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL')
      .andWhere('client.lastSent IS NOT NULL')
      .andWhere("TRIM(COALESCE(client.email, '')) <> ''")
      .andWhere('LOWER(COALESCE(client.sentBy, \'\')) LIKE :sentBy', { sentBy: `%${mailbox}%` })
      .orderBy('client.lastSent', 'DESC')
      .take(sentLimit)
      .getMany();

    const crmRepo = AppDataSource.getRepository(CrmClient);
    const crmRows = await crmRepo
      .createQueryBuilder('c')
      .where('LOWER(TRIM(COALESCE(c.sentByAccount, \'\'))) = :mailbox', { mailbox })
      .orderBy('c.updatedAt', 'DESC')
      .take(crmLimit)
      .getMany();

    const sentLeadTotal = await clientRepository
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL')
      .andWhere('client.lastSent IS NOT NULL')
      .andWhere('LOWER(COALESCE(client.sentBy, \'\')) LIKE :sentBy', { sentBy: `%${mailbox}%` })
      .getCount();

    const crmTotal = await crmRepo
      .createQueryBuilder('c')
      .where('LOWER(TRIM(COALESCE(c.sentByAccount, \'\'))) = :mailbox', { mailbox })
      .getCount();

    res.json({
      email,
      sentLeads: sentLeads.map((row) => ({
        id: row.id,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        companyName: row.companyName,
        status: row.status,
        lastSent: row.lastSent,
        isSent: row.isSent,
        isReplied: row.isReplied,
        isFollowup: row.isFollowup,
        sentBy: row.sentBy,
      })),
      sentLeadsTotal: sentLeadTotal,
      crmClients: crmRows.map(serializeCrmClient),
      crmClientsTotal: crmTotal,
    });
  } catch (error) {
    console.error('Get email detail error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getEmails(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const emailRepository = AppDataSource.getRepository(Email);

    const queryBuilder = emailRepository
      .createQueryBuilder('email')
      .leftJoinAndSelect('email.account', 'account');

    applyEmailListFilters(queryBuilder, req.query);

    const dataQuery = queryBuilder
      .orderBy('email.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    const countQuery = emailRepository.createQueryBuilder('email');
    applyEmailListFilters(countQuery, req.query);

    const [data, total] = await Promise.all([
      dataQuery.getMany(),
      countQuery.getCount(),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.json({
      data,
      page,
      limit,
      total,
      totalPages,
    });
  } catch (error) {
    console.error('Get emails error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createEmail(req, res) {
  try {
    if (!req.body.address && !req.body.email) {
      return res.status(400).json({ error: 'Email address is required' });
    }

    const emailRepository = AppDataSource.getRepository(Email);
    const emailAddress = normalizeEmailAddress(req.body.address || req.body.email);
    if (!emailAddress) {
      return res.status(400).json({ error: 'Email address is required' });
    }

    const emailData = buildEmailPayloadFromBody(req.body, emailAddress);

    const existingActive = await findActiveEmailByAddress(emailRepository, emailAddress);
    if (existingActive) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const softDeleted = await findSoftDeletedEmailByAddress(emailRepository, emailAddress);
    if (softDeleted) {
      await emailRepository.update(softDeleted.id, { ...emailData, deletedAt: null });
      const restored = await emailRepository.findOne({
        where: { id: softDeleted.id },
        relations: ['account'],
      });
      return res.status(200).json(restored);
    }

    const email = emailRepository.create(emailData);
    const savedEmail = await emailRepository.save(email);

    const emailWithAccount = await emailRepository.findOne({
      where: { id: savedEmail.id },
      relations: ['account'],
    });

    res.status(201).json(emailWithAccount);
  } catch (error) {
    console.error('Create email error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateEmail(req, res) {
  try {
    const emailRepository = AppDataSource.getRepository(Email);

    const email = await emailRepository.findOne({
      where: { id: req.params.id, deletedAt: null },
      relations: ['account'],
    });

    if (!email) {
      return res.status(404).json({ error: 'Email not found' });
    }

    if (req.body.address !== undefined) {
      const nextAddress = String(req.body.address).toLowerCase().trim();
      if (!nextAddress) {
        return res.status(400).json({ error: 'Email address is required' });
      }

      if (nextAddress !== normalizeEmailAddress(email.address)) {
        const existing = await findActiveEmailByAddress(emailRepository, nextAddress);
        if (existing && existing.id !== email.id) {
          return res.status(400).json({ error: 'Email already exists' });
        }
      }
      email.address = nextAddress;
    }

    if (req.body.status !== undefined) email.status = req.body.status;
    if (req.body.firstName !== undefined || req.body.first_name !== undefined) {
      email.firstName = req.body.firstName || req.body.first_name || null;
    }
    if (req.body.lastName !== undefined || req.body.last_name !== undefined) {
      email.lastName = req.body.lastName || req.body.last_name || null;
    }
    if (
      req.body.marketingDailyLimit !== undefined ||
      req.body.marketing_daily_limit !== undefined
    ) {
      const raw =
        req.body.marketingDailyLimit ?? req.body.marketing_daily_limit;
      if (raw === '' || raw === null || raw === undefined) {
        email.marketingDailyLimit = null;
      } else {
        const parsed = Number.parseInt(String(raw), 10);
        email.marketingDailyLimit =
          Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
      }
    }
    if (req.body.accountId !== undefined) email.accountId = req.body.accountId || null;
    if (req.body.password !== undefined) email.password = req.body.password || null;
    if (req.body.appPassword !== undefined || req.body.app_password !== undefined) {
      email.appPassword = req.body.appPassword || req.body.app_password || null;
    }
    if (req.body.twoFa !== undefined || req.body['2fa'] !== undefined) {
      email.twoFa = req.body.twoFa || req.body['2fa'] || null;
    }
    if (req.body.recoveryEmail !== undefined) email.recoveryEmail = req.body.recoveryEmail || null;
    if (req.body.grantId !== undefined || req.body.grant_id !== undefined) {
      email.grantId = req.body.grantId || req.body.grant_id || null;
    }
    if (req.body.nylasKey !== undefined || req.body.nylas_key !== undefined) {
      email.nylasKey = req.body.nylasKey || req.body.nylas_key || null;
    }
    if (req.body.chromePath !== undefined || req.body.chrome_path !== undefined) {
      email.chromePath = req.body.chromePath || req.body.chrome_path || null;
    }
    if (req.body.chromeUserDataDir !== undefined || req.body.chrome_user_data_dir !== undefined) {
      email.chromeUserDataDir = req.body.chromeUserDataDir || req.body.chrome_user_data_dir || null;
    }
    if (req.body.chromeProfileDirectory !== undefined || req.body.chrome_profile_directory !== undefined) {
      email.chromeProfileDirectory = req.body.chromeProfileDirectory || req.body.chrome_profile_directory || null;
    }
    if (req.body.gmailUIndex !== undefined || req.body.gmail_u_index !== undefined) {
      const nextUIndex = req.body.gmailUIndex ?? req.body.gmail_u_index;
      const parsedUIndex =
        nextUIndex === '' || nextUIndex === null || nextUIndex === undefined
          ? null
          : Number.parseInt(String(nextUIndex), 10);
      email.gmailUIndex = Number.isNaN(parsedUIndex) ? null : parsedUIndex;
    }

    const updatedEmail = await emailRepository.save(email);

    const emailWithAccount = await emailRepository.findOne({
      where: { id: updatedEmail.id },
      relations: ['account'],
    });

    res.json(emailWithAccount);
  } catch (error) {
    console.error('Update email error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function bulkDeleteEmails(req, res) {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'IDs array is required' });
    }

    const emailRepository = AppDataSource.getRepository(Email);
    
    // Soft delete by setting deletedAt
    const result = await emailRepository
      .createQueryBuilder()
      .update(Email)
      .set({ deletedAt: new Date() })
      .where('id IN (:...ids)', { ids })
      .andWhere('deletedAt IS NULL')
      .execute();

    res.json({
      success: true,
      deleted: result.affected || 0,
    });
  } catch (error) {
    console.error('Bulk delete emails error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function bulkUpdateEmails(req, res) {
  try {
    const { ids, updates } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'IDs array is required' });
    }

    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({ error: 'Updates object is required' });
    }

    // Only allow updating specific fields
    const allowedFields = ['status', 'accountId'];
    const updateData = {};
    
    for (const field of allowedFields) {
      if (field in updates) {
        // Handle accountId - allow null to unlink
        if (field === 'accountId') {
          updateData[field] = updates[field] || null;
        } else {
          updateData[field] = updates[field];
        }
      }
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const emailRepository = AppDataSource.getRepository(Email);
    
    const result = await emailRepository
      .createQueryBuilder()
      .update(Email)
      .set(updateData)
      .where('id IN (:...ids)', { ids })
      .andWhere('deletedAt IS NULL')
      .execute();

    res.json({
      success: true,
      updated: result.affected || 0,
    });
  } catch (error) {
    console.error('Bulk update emails error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function uploadEmails(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const emailRepository = AppDataSource.getRepository(Email);
    const results = [];
    const errors = [];
    let processed = 0;

    const filePath = req.file.path;
    const fileName = req.file.originalname.toLowerCase();
    const fileExtension = fileName.split('.').pop();

    let rows = [];

    if (fileExtension === 'csv') {
      // Parse CSV
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const lines = fileContent.split('\n').filter(line => line.trim());

      if (lines.length < 2) {
        await fs.unlink(filePath).catch(() => {});
        return res.status(400).json({ error: 'CSV file must have at least a header and one data row' });
      }

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

      const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, ''));

      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        const row = {};
        headers.forEach((header, index) => {
          if (values[index]) {
            row[header] = values[index];
          }
        });
        rows.push(row);
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
          return res.status(400).json({ error: 'Excel file must have at least a header and one data row' });
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
      } catch (error) {
        await fs.unlink(filePath).catch(() => {});
        return res.status(400).json({ error: `Error parsing Excel file: ${error.message}` });
      }
    } else {
      await fs.unlink(filePath).catch(() => {});
      return res.status(400).json({ error: 'Unsupported file format. Please use CSV, XLSX, or XLS.' });
    }

    // Helper function to get field value from multiple possible column names
    function getField(row, ...fieldNames) {
      for (const fieldName of fieldNames) {
        const value = row[fieldName];
        if (value !== undefined && value !== null && value !== '') {
          return String(value).trim();
        }
      }
      return null;
    }

    // Helper function to validate email format
    function isValidEmail(email) {
      if (!email) return false;
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      return emailRegex.test(email);
    }

    // Debug: Log parsed rows info
    console.log(`Parsed ${rows.length} rows from file`);
    if (rows.length > 0) {
      console.log('Sample row keys:', Object.keys(rows[0]));
      console.log('First row data:', rows[0]);
    }

    // Process rows
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const emailAddress = getField(row, 'email', 'address', 'emailaddress', 'email_address', 'e-mail', 'e_mail');

      if (emailAddress) {
        // Validate email format
        if (!isValidEmail(emailAddress)) {
          errors.push({ row: i + 2, email: emailAddress, error: 'Invalid email format' });
          continue;
        }

        try {
          const emailData = {
            address: emailAddress.toLowerCase().trim(),
            firstName: getField(row, 'firstname', 'first_name', 'first') || null,
            lastName: getField(row, 'lastname', 'last_name', 'last') || null,
            marketingDailyLimit: (() => {
              const raw = getField(
                row,
                'marketingdailylimit',
                'marketing_daily_limit',
                'dailylimit',
                'daily_limit'
              );
              if (!raw) return null;
              const n = Number.parseInt(String(raw), 10);
              return Number.isNaN(n) || n <= 0 ? null : n;
            })(),
            accountId: getField(row, 'accountid', 'account_id', 'account') || null,
            status: getField(row, 'status') || 'new',
            password: getField(row, 'password', 'pass') || null,
            twoFa: getField(row, '2fa', 'twofa', 'two_fa', 'twofactor', 'two_factor') || null,
            recoveryEmail: getField(row, 'recoveryemail', 'recovery_email', 'recovery', 'backupemail', 'backup_email') || null,
            grantId: getField(row, 'grantid', 'grant_id') || null,
            nylasKey: getField(row, 'nylaskey', 'nylas_key', 'nylasapikey', 'nylas_api_key') || null,
            chromePath: getField(row, 'chromepath', 'chrome_path') || null,
            chromeUserDataDir: getField(row, 'chromeuserdatadir', 'chrome_user_data_dir', 'userdatadir', 'user_data_dir') || null,
            chromeProfileDirectory: getField(row, 'chromeprofiledirectory', 'chrome_profile_directory', 'profiledirectory', 'profile_directory') || null,
            gmailUIndex: getField(row, 'gmailuindex', 'gmail_u_index', 'uindex', 'u_index'),
          };
          if (emailData.gmailUIndex !== null) {
            const parsedUIndex = Number.parseInt(String(emailData.gmailUIndex), 10);
            emailData.gmailUIndex = Number.isNaN(parsedUIndex) ? null : parsedUIndex;
          }

          // Check if email already exists
          const existing = await emailRepository.findOne({
            where: { address: emailData.address, deletedAt: null },
          });

          if (!existing) {
            const email = emailRepository.create(emailData);
            const savedEmail = await emailRepository.save(email);
            results.push(savedEmail);
            processed++;
            console.log(`Created email: ${emailData.address}`);
          } else {
            errors.push({ row: i + 2, email: emailData.address, error: 'Email already exists' });
          }
        } catch (error) {
          console.error(`Error processing row ${i + 2}:`, error);
          errors.push({ row: i + 2, email: emailAddress, error: error.message || String(error) });
        }
      } else {
        // Debug: Log why email wasn't found
        const availableKeys = Object.keys(row);
        errors.push({ 
          row: i + 2, 
          error: `Email address is required. Available columns: ${availableKeys.join(', ')}` 
        });
      }
    }

    console.log(`Upload complete: ${results.length} created, ${errors.length} errors`);

    // Clean up uploaded file
    try {
      await fs.unlink(filePath);
    } catch (err) {
      console.error('Error deleting temp file:', err);
    }

    res.json({
      success: true,
      processed,
      created: results.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Upload emails error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Lists CRM email mailboxes with any Nylas fields set, and live-checks grant + API key when both are present.
 * GET /api/emails/nylas-integration-status?staggerMs=120
 */
export async function getNylasIntegrationStatus(req, res) {
  try {
    const staggerMs = Math.min(2000, Math.max(0, parseInt(String(req.query.staggerMs || '120'), 10) || 120));
    const emailRepository = AppDataSource.getRepository(Email);
    const emails = await emailRepository
      .createQueryBuilder('email')
      .where('email.deletedAt IS NULL')
      .andWhere(
        `(
          (email.grant_id IS NOT NULL AND TRIM(email.grant_id) <> '')
          OR (email.nylas_key IS NOT NULL AND TRIM(email.nylas_key) <> '')
        )`
      )
      .orderBy('email.address', 'ASC')
      .getMany();

    const data = [];
    for (let i = 0; i < emails.length; i += 1) {
      const row = emails[i];
      const grantId = String(row.grantId || '').trim();
      const nylasKey = String(row.nylasKey || '').trim();
      const hasGrant = Boolean(grantId);
      const hasKey = Boolean(nylasKey);

      let status = 'incomplete';
      let httpStatus = null;
      let detail = '';

      if (!hasGrant) {
        detail = 'Grant ID is missing (Nylas cannot be used for this mailbox).';
      } else if (!hasKey) {
        detail = 'Nylas API key is missing.';
      } else {
        const probe = await probeNylasGrantMessagesList(grantId, nylasKey);
        httpStatus = probe.httpStatus;
        detail = probe.detail || '';
        if (probe.ok) status = 'ok';
        else if (probe.code === 'invalid_api_key') status = 'invalid_api_key';
        else if (probe.code === 'grant_not_found') status = 'grant_not_found';
        else if (probe.code === 'forbidden') status = 'forbidden';
        else if (probe.code === 'rate_limited') status = 'rate_limited';
        else if (probe.code === 'network_error') status = 'network_error';
        else status = 'error';
      }

      data.push({
        id: row.id,
        address: row.address,
        hasGrantId: hasGrant,
        hasNylasKey: hasKey,
        grantIdPreview: hasGrant ? `${grantId.slice(0, 8)}…` : null,
        status,
        httpStatus,
        detail,
      });

      if (hasGrant && hasKey && staggerMs > 0 && i < emails.length - 1) {
        await sleep(staggerMs);
      }
    }

    res.json({ data, checkedAt: new Date().toISOString() });
  } catch (error) {
    console.error('getNylasIntegrationStatus error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function lookupEmailRecipients(req, res) {
  try {
    const raw = req.query.emails ?? req.query.email ?? '';
    const emails =
      typeof raw === 'string'
        ? raw.split(',').map((s) => s.trim()).filter(Boolean)
        : Array.isArray(raw)
          ? raw
          : [];
    const recipients = await lookupRecipientsByEmails(emails);
    res.json({ recipients });
  } catch (error) {
    console.error('lookupEmailRecipients error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function sendEmailFromMailboxHandler(req, res) {
  try {
    const result = await sendEmailFromMailbox(req.params.id, req.body || {});
    res.json(result);
  } catch (error) {
    console.error('sendEmailFromMailbox error:', error);
    res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
  }
}
