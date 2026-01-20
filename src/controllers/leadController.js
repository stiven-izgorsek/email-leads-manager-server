import { AppDataSource } from '../config/database.js';
import { Client } from '../entities/Client.js';
import fs from 'fs/promises';

export async function getLeads(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const clientRepository = AppDataSource.getRepository(Client);

    const queryBuilder = clientRepository
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL');

    if (req.query.search) {
      queryBuilder.andWhere(
        '(client.email ILIKE :search OR client.firstName ILIKE :search OR client.lastName ILIKE :search OR client.companyName ILIKE :search)',
        { search: `%${req.query.search}%` }
      );
    }

    if (req.query.status) {
      queryBuilder.andWhere('client.status = :status', { status: req.query.status });
    }

    if (req.query.assignedTo || req.query.contactedBy) {
      // For array fields, we need to check if the value is in the array
      // TypeORM simple-array is stored as comma-separated string
      const assignedTo = req.query.assignedTo || req.query.contactedBy;
      queryBuilder.andWhere('client.contactedBy LIKE :assignedTo', { assignedTo: `%${assignedTo}%` });
    }

    const dataQuery = queryBuilder
      .orderBy('client.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    const countQuery = clientRepository
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL');

    if (req.query.search) {
      countQuery.andWhere(
        '(client.email ILIKE :search OR client.firstName ILIKE :search OR client.lastName ILIKE :search OR client.companyName ILIKE :search)',
        { search: `%${req.query.search}%` }
      );
    }

    if (req.query.status) {
      countQuery.andWhere('client.status = :status', { status: req.query.status });
    }

    if (req.query.assignedTo || req.query.contactedBy) {
      const assignedTo = req.query.assignedTo || req.query.contactedBy;
      countQuery.andWhere('client.contactedBy LIKE :assignedTo', { assignedTo: `%${assignedTo}%` });
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
    console.error('Get leads error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createLead(req, res) {
  try {
    const clientRepository = AppDataSource.getRepository(Client);

    // Map request body to Client entity fields
    const clientData = {
      email: (req.body.email || req.body.Email || '').toLowerCase(),
      firstName: req.body.firstName || null,
      lastName: req.body.lastName || null,
      companyName: req.body.companyName || req.body.company || null,
      companyUrl: req.body.companyUrl || req.body.website || null,
      linkedin: req.body.linkedin || null,
      jobTitle: req.body.jobTitle || req.body.title || null,
      location: req.body.location || (req.body.city && req.body.state ? `${req.body.city}, ${req.body.state}` : req.body.city || req.body.state || null),
      companyLocation: req.body.companyLocation || (req.body.country || null),
      status: req.body.status || 'new',
      contactedBy: req.body.contactedBy || (req.body.assignedTo ? [req.body.assignedTo] : null),
      industries: req.body.industries || null,
      tech: req.body.tech || null,
      employees: req.body.employees || null,
      photoUrl: req.body.photoUrl || null,
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

    const clientRepository = AppDataSource.getRepository(Client);
    const results = [];
    const errors = [];
    let processed = 0;

    // Read and parse CSV
    const filePath = req.file.path;
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const lines = fileContent.split('\n').filter(line => line.trim());

    if (lines.length < 2) {
      await fs.unlink(filePath).catch(() => {});
      return res.status(400).json({ error: 'CSV file must have at least a header and one data row' });
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

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      const row = {};

      headers.forEach((header, index) => {
        if (values[index]) {
          row[header] = values[index];
        }
      });

      // Handle different email field names (email, workemail, work_email, etc.)
      const email = getField(row, 'email', 'workemail', 'work_email', 'e-mail', 'e_mail') || '';
      if (email) {
        try {
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
            linkedinUrl = linkedinUrl.trim();
            if (linkedinUrl && !linkedinUrl.startsWith('http')) {
              linkedinUrl = `https://${linkedinUrl}`;
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

          // Handle firstName - check multiple variations
          const firstName = getField(row, 'firstname', 'first_name', 'firstname', 'fname', 'f_name', 'givenname', 'given_name');

          // Handle lastName - check multiple variations
          const lastName = getField(row, 'lastname', 'last_name', 'lastname', 'lname', 'l_name', 'surname', 'familyname', 'family_name');

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

          const clientData = {
            email: email.toLowerCase().trim(),
            firstName: firstName || null,
            lastName: lastName || null,
            companyName: companyName || null,
            companyUrl: companyUrl || null,
            linkedin: linkedinUrl || null,
            jobTitle: jobTitle || null,
            location: location || null,
            companyLocation: companyLocation || null,
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
            tech: (() => {
              const value = getField(row, 'tech', 'technologies', 'technology');
              if (!value) return null;
              return Array.isArray(value) ? value : value.split(',').map(t => t.trim()).filter(t => t);
            })(),
          };

          // Check if client already exists
          const existing = await clientRepository.findOne({
            where: { email: clientData.email, deletedAt: null },
          });

          if (!existing) {
            const client = clientRepository.create(clientData);
            const savedClient = await clientRepository.save(client);
            results.push(savedClient);
            processed++;
          } else {
            errors.push({ row: i + 1, email: clientData.email, error: 'Lead already exists' });
          }
        } catch (error) {
          errors.push({ row: i + 1, error: error.message });
        }
      } else {
        errors.push({ row: i + 1, error: 'Email is required' });
      }
    }

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
    console.error('Upload leads error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
