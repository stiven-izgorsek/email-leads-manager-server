import { AppDataSource } from '../config/database.js';
import { Email } from '../entities/Email.js';
import fs from 'fs/promises';
import XLSX from 'xlsx';

export async function getEmails(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const emailRepository = AppDataSource.getRepository(Email);

    const queryBuilder = emailRepository
      .createQueryBuilder('email')
      .leftJoinAndSelect('email.account', 'account')
      .where('email.deletedAt IS NULL');

    if (req.query.search) {
      queryBuilder.andWhere('email.address ILIKE :search', { search: `%${req.query.search}%` });
    }

    const dataQuery = queryBuilder
      .orderBy('email.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    // Create a separate query for count
    const countQuery = emailRepository
      .createQueryBuilder('email')
      .where('email.deletedAt IS NULL');
    
    if (req.query.search) {
      countQuery.andWhere('email.address ILIKE :search', { search: `%${req.query.search}%` });
    }

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
    
    const emailAddress = (req.body.address || req.body.email).toLowerCase();
    
    // Check if email already exists
    const existingEmail = await emailRepository.findOne({
      where: { address: emailAddress, deletedAt: null },
    });

    if (existingEmail) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const emailData = {
      address: emailAddress,
      accountId: req.body.accountId || null,
      status: req.body.status || 'new',
      password: req.body.password || null,
      twoFa: req.body.twoFa || req.body['2fa'] || null,
      recoveryEmail: req.body.recoveryEmail || null,
      grantId: req.body.grantId || req.body.grant_id || null,
      nylasKey: req.body.nylasKey || req.body.nylas_key || null,
    };

    const email = emailRepository.create(emailData);
    const savedEmail = await emailRepository.save(email);

    // Load with relation
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

      if (nextAddress !== email.address) {
        const existing = await emailRepository.findOne({
          where: { address: nextAddress, deletedAt: null },
        });
        if (existing && existing.id !== email.id) {
          return res.status(400).json({ error: 'Email already exists' });
        }
      }
      email.address = nextAddress;
    }

    if (req.body.status !== undefined) email.status = req.body.status;
    if (req.body.accountId !== undefined) email.accountId = req.body.accountId || null;
    if (req.body.password !== undefined) email.password = req.body.password || null;
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
            accountId: getField(row, 'accountid', 'account_id', 'account') || null,
            status: getField(row, 'status') || 'new',
            password: getField(row, 'password', 'pass') || null,
            twoFa: getField(row, '2fa', 'twofa', 'two_fa', 'twofactor', 'two_factor') || null,
            recoveryEmail: getField(row, 'recoveryemail', 'recovery_email', 'recovery', 'backupemail', 'backup_email') || null,
            grantId: getField(row, 'grantid', 'grant_id') || null,
            nylasKey: getField(row, 'nylaskey', 'nylas_key', 'nylasapikey', 'nylas_api_key') || null,
          };

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
