import { AppDataSource } from '../config/database.js';
import { Client } from '../entities/Client.js';
import { LeadFilter } from '../entities/LeadFilter.js';
import { In } from 'typeorm';
import fs from 'fs/promises';
import XLSX from 'xlsx';
import path from 'path';
import { verifyEmailsBulk } from '../services/millionsService.js';

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
      // Handle both NULL and 'new' as 'new' status (since default is 'new')
      if (req.query.status === 'new') {
        queryBuilder.andWhere('(client.status = :status OR client.status IS NULL)', { status: req.query.status });
      } else {
        queryBuilder.andWhere('client.status = :status', { status: req.query.status });
      }
    }

    if (req.query.location) {
      queryBuilder.andWhere(
        '(client.location ILIKE :location OR client.companyLocation ILIKE :location)',
        { location: `%${req.query.location}%` }
      );
    }

    // Filter by leadFilterIds (include or exclude)
    if (req.query.leadFilterIds) {
      const leadFilterIds = Array.isArray(req.query.leadFilterIds) 
        ? req.query.leadFilterIds 
        : req.query.leadFilterIds.split(',').filter(id => id.trim());
      const filterMode = req.query.leadFilterMode || 'include'; // 'include' or 'exclude'
      
      if (leadFilterIds.length > 0) {
        if (filterMode === 'exclude') {
          queryBuilder.andWhere('(client.leadFilterId IS NULL OR client.leadFilterId NOT IN (:...leadFilterIds))', { leadFilterIds });
        } else {
          queryBuilder.andWhere('client.leadFilterId IN (:...leadFilterIds)', { leadFilterIds });
        }
      }
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
      // Handle both NULL and 'new' as 'new' status (since default is 'new')
      if (req.query.status === 'new') {
        countQuery.andWhere('(client.status = :status OR client.status IS NULL)', { status: req.query.status });
      } else {
        countQuery.andWhere('client.status = :status', { status: req.query.status });
      }
    }

    if (req.query.location) {
      countQuery.andWhere(
        '(client.location ILIKE :location OR client.companyLocation ILIKE :location)',
        { location: `%${req.query.location}%` }
      );
    }

    // Filter by leadFilterIds (include or exclude)
    if (req.query.leadFilterIds) {
      const leadFilterIds = Array.isArray(req.query.leadFilterIds) 
        ? req.query.leadFilterIds 
        : req.query.leadFilterIds.split(',').filter(id => id.trim());
      const filterMode = req.query.leadFilterMode || 'include'; // 'include' or 'exclude'
      
      if (leadFilterIds.length > 0) {
        if (filterMode === 'exclude') {
          countQuery.andWhere('(client.leadFilterId IS NULL OR client.leadFilterId NOT IN (:...leadFilterIds))', { leadFilterIds });
        } else {
          countQuery.andWhere('client.leadFilterId IN (:...leadFilterIds)', { leadFilterIds });
        }
      }
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

    const clientRepository = AppDataSource.getRepository(Client);
    const leadFilterRepository = AppDataSource.getRepository(LeadFilter);
    const results = [];
    const errors = [];
    let processed = 0;

    // Parse LeadFilter from request if provided
    let leadFilterId = null;
    let leadFilterMillionsStatus = null;
    if (req.body.leadFilter) {
      try {
        const leadFilterData = typeof req.body.leadFilter === 'string' 
          ? JSON.parse(req.body.leadFilter) 
          : req.body.leadFilter;
        
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

    // Read and parse file (CSV or XLSX)
    const filePath = req.file.path;
    const fileExtension = path.extname(req.file.originalname).toLowerCase().slice(1);
    const rows = [];

    if (fileExtension === 'csv') {
      // Parse CSV
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

    // Process data rows
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

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
            leadFilterId: leadFilterId,
            millionsStatus,
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
            // Client exists - check if firstName or lastName need to be updated
            const updateData = {};
            let needsUpdate = false;

            // Update firstName if it's missing in DB but present in upload
            if (!existing.firstName && clientData.firstName) {
              updateData.firstName = clientData.firstName;
              needsUpdate = true;
            }

            // Update lastName if it's missing in DB but present in upload
            if (!existing.lastName && clientData.lastName) {
              updateData.lastName = clientData.lastName;
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
              errors.push({ row: i + 2, email: clientData.email, error: 'Lead already exists' });
            }
          }
        } catch (error) {
          errors.push({ row: i + 2, error: error.message });
        }
      } else {
        errors.push({ row: i + 2, error: 'Email is required' });
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

    const clientRepository = AppDataSource.getRepository(Client);

    // Fetch new uncontacted leads (excluding 'ready' and 'followedup' status - those are managed by extension locally or already followed up)
    // Only fetch leads that haven't been fetched by any extension yet and haven't been followed up
    const queryBuilder = clientRepository
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL')
      .andWhere('(client.isSent = false OR client.isSent IS NULL)') // Only uncontacted leads
      .andWhere('(client.status != :readyStatus OR client.status IS NULL)', { readyStatus: 'ready' }) // Exclude 'ready' status
      .andWhere('(client.status != :followedupStatus OR client.status IS NULL)', { followedupStatus: 'followedup' }); // Exclude 'followedup' status

    // When verifiedOnly is true (default), only return leads with 'good' or 'risky' millionsStatus
    if (verifiedOnly) {
      queryBuilder.andWhere('client.millionsStatus IN (:...millionsStatuses)', { millionsStatuses: ['good', 'risky'] });
    }

    // Filter by leadFilterId if provided (include or exclude)
    if (leadFilterId) {
      if (leadFilterMode === 'exclude') {
        // Exclude leads with this filter ID (include NULL and other filter IDs)
        // Use NOT IN with array to match the pattern used in getLeads
        queryBuilder.andWhere('(client.leadFilterId IS NULL OR client.leadFilterId NOT IN (:...leadFilterIds))', { 
          leadFilterIds: [leadFilterId] 
        });
      } else {
        // Include only leads with this filter ID
        queryBuilder.andWhere('client.leadFilterId = :leadFilterId', { leadFilterId });
      }
    }

    // Filter by location if provided
    if (location) {
      queryBuilder.andWhere('(client.location ILIKE :location OR client.companyLocation ILIKE :location)', {
        location: `%${location}%`,
      });
    }

    // Filter by industry if provided
    if (industry) {
      // For simple-array fields, check if the array contains the industry
      queryBuilder.andWhere('client.industries LIKE :industry', {
        industry: `%${industry}%`,
      });
    }

    const leads = await queryBuilder
      .orderBy(
        `CASE 
          WHEN client.millionsStatus = 'good' THEN 1 
          WHEN client.millionsStatus = 'risky' THEN 2 
          ELSE 3 
        END`,
        'ASC'
      ) // Prioritize 'good' over 'risky'
      .addOrderBy('client.createdAt', 'DESC') // Then by creation date
      .take(count)
      .getMany();
    
    console.log('[getUncontactedLeads] Found', leads.length, 'leads. Filter mode:', leadFilterMode, 'Filter ID:', leadFilterId);

    // Mark fetched leads as 'ready' so other extensions won't fetch them
    if (leads.length > 0) {
      const leadIds = leads.map(lead => lead.id);
      await clientRepository.update(
        { id: In(leadIds) },
        { status: 'ready' }
      );
    }

    // Format response to match extension expectations
    const formattedLeads = leads.map(lead => ({
      id: lead.id,
      first_name: lead.firstName || '',
      firstName: lead.firstName || '',
      company_name: lead.companyName || '',
      companyName: lead.companyName || '',
      companyUrl: lead.companyUrl || '',
      industries: lead.industries || [],
      tech: lead.tech || [],
      jobTitle: lead.jobTitle || '',
      companyLocation: lead.companyLocation || '',
      email: lead.email || '',
      icebreaker_title: null, // Can be added later if needed
      icebreaker: null, // Can be added later if needed
      used: false,
    }));

    res.json({
      data: formattedLeads,
      meta: {
        total: formattedLeads.length,
        count: formattedLeads.length,
      },
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
    const { email } = req.body;

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

    // Prepare update data
    const updateData = {
      isFollowup: true,
      status: 'followedup',
      lastSent: new Date(),
    };

    // Update the client
    await clientRepository.update({ id: client.id }, updateData);

    // Return updated client
    const updatedClient = await clientRepository.findOne({
      where: { id: client.id },
    });

    return res.json({ message: 'Client marked as followed up', data: updatedClient });
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
      data: updatedClient,
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
    const allowedFields = ['status', 'isSent', 'isReplied', 'lastSent', 'contactedBy'];
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
    clients.forEach(client => {
      clientsMap.set(client.email.toLowerCase(), {
        id: client.id,
        email: client.email,
        firstName: client.firstName,
        lastName: client.lastName,
        companyName: client.companyName,
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
    
    // Count emails sent today (isSent = true AND lastSent is today)
    const emailsSentToday = await clientRepository
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL')
      .andWhere('client.isSent = :isSent', { isSent: true })
      .andWhere('client.lastSent >= :today', { today })
      .andWhere('client.lastSent < :tomorrow', { tomorrow })
      .getCount();
    
    // Count emails sent this week
    const emailsSentThisWeek = await clientRepository
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL')
      .andWhere('client.isSent = :isSent', { isSent: true })
      .andWhere('client.lastSent >= :weekStart', { weekStart })
      .andWhere('client.lastSent < :tomorrow', { tomorrow })
      .getCount();
    
    // Count emails sent this month
    const emailsSentThisMonth = await clientRepository
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL')
      .andWhere('client.isSent = :isSent', { isSent: true })
      .andWhere('client.lastSent >= :monthStart', { monthStart })
      .andWhere('client.lastSent < :tomorrow', { tomorrow })
      .getCount();
    
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
    
    const clientRepository = AppDataSource.getRepository(Client);
    
    // Count emails sent in the date range
    const emailsSent = await clientRepository
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL')
      .andWhere('client.isSent = :isSent', { isSent: true })
      .andWhere('client.lastSent >= :start', { start })
      .andWhere('client.lastSent <= :end', { end })
      .getCount();
    
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

    const clientRepository = AppDataSource.getRepository(Client);
    
    // Reset status from 'ready' to 'new' for the specified leads
    const result = await clientRepository
      .createQueryBuilder()
      .update(Client)
      .set({ status: 'new' })
      .where('id IN (:...leadIds)', { leadIds })
      .andWhere('status = :readyStatus', { readyStatus: 'ready' })
      .andWhere('deletedAt IS NULL')
      .execute();

    res.json({
      success: true,
      reset: result.affected || 0,
    });
  } catch (error) {
    console.error('Reset leads status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// In-memory storage for verification job status
const verificationJobs = new Map();

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

    const clientRepository = AppDataSource.getRepository(Client);
    
    // Fetch all clients with status "new" that have emails and are not already verified
    // Handle both NULL and 'new' as 'new' status (since default is 'new')
    const clients = await clientRepository
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL')
      .andWhere('(client.status = :status OR client.status IS NULL)', { status: 'new' })
      .getMany();

    // Filter out clients without emails or already verified (good/risky)
    const clientsToVerify = clients.filter(client => {
      return client.email && 
             client.email.trim() !== '' && 
             (!client.millionsStatus || client.millionsStatus === 'bad' || client.millionsStatus === 'error');
    });

    if (clientsToVerify.length === 0) {
      return res.status(400).json({ error: 'No valid emails to verify. All "new" status leads are either missing emails or already verified.' });
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
      message: 'Verification started for all "new" status leads',
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
    const clientRepository = AppDataSource.getRepository(Client);
    
    // Fetch all clients with status "new" that have emails and are not already verified
    // Handle both NULL and 'new' as 'new' status (since default is 'new')
    const clients = await clientRepository
      .createQueryBuilder('client')
      .where('client.deletedAt IS NULL')
      .andWhere('(client.status = :status OR client.status IS NULL)', { status: 'new' })
      .getMany();

    // Filter out clients without emails or already verified (good/risky)
    const clientsToVerify = clients.filter(client => {
      return client.email && 
             client.email.trim() !== '' && 
             (!client.millionsStatus || client.millionsStatus === 'bad' || client.millionsStatus === 'error');
    });

    res.json({
      count: clientsToVerify.length,
      totalNew: clients.length,
      alreadyVerified: clients.length - clientsToVerify.length,
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
