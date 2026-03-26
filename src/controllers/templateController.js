import { AppDataSource } from '../config/database.js';
import { Template } from '../entities/Template.js';
import { Like } from 'typeorm';

function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function renderTemplateVariables(template, vars) {
  if (typeof template !== 'string' || !template.length) return '';

  // Handle RANDOM selections: {{RANDOM | a | b}}
  let result = template.replace(/{{RANDOM\s*\|\s*([^}]+)}}/gi, (match, optionsRaw) => {
    const options = String(optionsRaw || '')
      .split('|')
      .map(s => s.trim())
      .filter(Boolean);
    if (options.length === 0) return '';
    return options[Math.floor(Math.random() * options.length)];
  });

  // Handle fallback: {{key | fallback}}
  result = result.replace(/{{([^|}]+)\s*\|\s*([^}]+)}}/g, (match, keyRaw, fallbackRaw) => {
    const key = String(keyRaw || '').trim();
    const fallback = String(fallbackRaw ?? '').trim();
    const value = (vars && Object.prototype.hasOwnProperty.call(vars, key)) ? vars[key] : undefined;
    const finalValue = value ?? fallback;
    return finalValue ? String(finalValue) : '';
  });

  // Handle regular variables
  const replacements = [
    ['firstName', vars?.firstName],
    ['companyName', vars?.companyName || 'your company'],
    ['email', vars?.email],
    ['senderName', vars?.senderName],
    ['icebreakerTitle', vars?.icebreakerTitle],
    ['icebreaker', vars?.icebreaker],
  ];

  for (const [tokenName, value] of replacements) {
    const token = new RegExp(`{{${tokenName}}}`, 'gi');
    result = result.replace(token, value ? String(value) : '');
  }

  return result;
}

export async function composeEmailFromTemplates(req, res) {
  try {
    const { accountName, accountEmail, lead, messageType } = req.body || {};
    const requestedType = messageType && typeof messageType === 'string' ? messageType : 'outreach';

    if (!lead || typeof lead !== 'object') {
      return res.status(400).json({ error: 'lead is required' });
    }

    const subjectRepo = AppDataSource.getRepository(Template);

    // Pick one subject template
    const subjectTemplate = await subjectRepo.createQueryBuilder('template')
      .where('template.deletedAt IS NULL')
      .andWhere('template.type = :type', { type: 'subject' })
      .orderBy('RANDOM()')
      .take(1)
      .getOne();

    if (!subjectTemplate) {
      return res.status(404).json({ error: 'No subject templates found' });
    }

    // Pick one message template (outreach/followup/2nd-followup)
    const messageTemplate = await subjectRepo.createQueryBuilder('template')
      .where('template.deletedAt IS NULL')
      .andWhere("template.type IN ('outreach', 'followup', '2nd-followup')")
      .andWhere('template.type = :type', { type: requestedType })
      .orderBy('RANDOM()')
      .take(1)
      .getOne();

    if (!messageTemplate) {
      return res.status(404).json({ error: `No message templates found for type ${requestedType}` });
    }

    // Normalize lead variables for {{...}} replacement
    const normalizedLead = {
      firstName: lead.firstName ?? lead.first_name ?? '',
      companyName: lead.companyName ?? lead.company_name ?? '',
      email: lead.email ?? '',
      icebreakerTitle: lead.icebreakerTitle ?? lead.icebreaker_title ?? '',
      icebreaker: lead.icebreaker ?? '',
    };

    const senderVars = {
      senderName: accountName ?? '',
      email: accountEmail ?? '',
    };

    const vars = {
      ...normalizedLead,
      ...senderVars,
    };

    const subject = renderTemplateVariables(subjectTemplate.content, vars);
    const template = renderTemplateVariables(messageTemplate.content, vars);

    return res.json({
      subject,
      template,
      subjectTemplateId: subjectTemplate.id,
      messageTemplateId: messageTemplate.id,
    });
  } catch (error) {
    console.error('composeEmailFromTemplates error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getSubjectTemplates(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const templateRepository = AppDataSource.getRepository(Template);

    const queryBuilder = templateRepository
      .createQueryBuilder('template')
      .where('template.deletedAt IS NULL')
      .andWhere('template.type = :type', { type: 'subject' });

    if (req.query.search) {
      queryBuilder.andWhere('template.content ILIKE :search', {
        search: `%${req.query.search}%`,
      });
    }

    const countQuery = templateRepository
      .createQueryBuilder('template')
      .where('template.deletedAt IS NULL')
      .andWhere('template.type = :type', { type: 'subject' });

    if (req.query.search) {
      countQuery.andWhere('template.content ILIKE :search', {
        search: `%${req.query.search}%`,
      });
    }

    const [data, total] = await Promise.all([
      queryBuilder
        .orderBy('template.createdAt', 'DESC')
        .skip(skip)
        .take(limit)
        .getMany(),
      countQuery.getCount(),
    ]);

    const totalPages = Math.ceil(total / limit);

    // Map to frontend expected format
    const formattedData = data.map(template => ({
      _id: template.id, // Frontend expects _id
      id: template.id,
      content: template.content,
      used: 0, // TODO: Add tracking for used count
      replied: 0, // TODO: Add tracking for replied count
      succeeded: 0, // TODO: Add tracking for succeeded count
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    }));

    res.json({
      data: formattedData,
      page,
      limit,
      total,
      totalPages,
    });
  } catch (error) {
    console.error('Get subject templates error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createSubjectTemplate(req, res) {
  try {
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }

    const templateRepository = AppDataSource.getRepository(Template);

    const template = templateRepository.create({
      content: content.trim(),
      type: 'subject',
      tech: null,
      industries: null,
    });

    const savedTemplate = await templateRepository.save(template);

    // Format response to match frontend expectations
    const formattedData = {
      _id: savedTemplate.id,
      id: savedTemplate.id,
      content: savedTemplate.content,
      used: 0,
      replied: 0,
      succeeded: 0,
      createdAt: savedTemplate.createdAt,
      updatedAt: savedTemplate.updatedAt,
    };

    res.status(201).json(formattedData);
  } catch (error) {
    console.error('Create subject template error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createMessageTemplate(req, res) {
  try {
    const { content, type, industries, tech } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }

    if (!type || !['outreach', 'followup', '2nd-followup'].includes(type)) {
      return res.status(400).json({ error: 'Valid type is required (outreach, followup, 2nd-followup)' });
    }

    const templateRepository = AppDataSource.getRepository(Template);

    const template = templateRepository.create({
      content: content.trim(),
      type: type,
      tech: Array.isArray(tech) ? tech : (tech ? [tech] : null),
      industries: Array.isArray(industries) ? industries : (industries ? [industries] : null),
    });

    const savedTemplate = await templateRepository.save(template);

    // Format response to match frontend expectations
    const formattedData = {
      _id: savedTemplate.id,
      id: savedTemplate.id,
      content: savedTemplate.content,
      type: savedTemplate.type,
      industry: savedTemplate.industries && savedTemplate.industries.length > 0 
        ? savedTemplate.industries[0] 
        : '',
      industries: savedTemplate.industries || [],
      skills: savedTemplate.tech || [],
      tech: savedTemplate.tech || [],
      used: 0,
      replied: 0,
      succeeded: 0,
      createdAt: savedTemplate.createdAt,
      updatedAt: savedTemplate.updatedAt,
    };

    res.status(201).json(formattedData);
  } catch (error) {
    console.error('Create message template error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getMessageTemplates(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const templateRepository = AppDataSource.getRepository(Template);

    const queryBuilder = templateRepository
      .createQueryBuilder('template')
      .where('template.deletedAt IS NULL')
      .andWhere("template.type IN ('outreach', 'followup', '2nd-followup')");

    // Filter by type if provided
    if (req.query.type) {
      queryBuilder.andWhere('template.type = :type', { type: req.query.type });
    }

    if (req.query.search) {
      queryBuilder.andWhere(
        '(template.content ILIKE :search OR template.industries::text ILIKE :search)',
        { search: `%${req.query.search}%` }
      );
    }

    if (req.query.industry) {
      // For simple-array, check if the array contains the industry
      queryBuilder.andWhere('template.industries::text ILIKE :industry', {
        industry: `%${req.query.industry}%`,
      });
    }

    const countQuery = templateRepository
      .createQueryBuilder('template')
      .where('template.deletedAt IS NULL')
      .andWhere("template.type IN ('outreach', 'followup', '2nd-followup')");

    if (req.query.type) {
      countQuery.andWhere('template.type = :type', { type: req.query.type });
    }

    if (req.query.search) {
      countQuery.andWhere(
        '(template.content ILIKE :search OR template.industries::text ILIKE :search)',
        { search: `%${req.query.search}%` }
      );
    }

    if (req.query.industry) {
      countQuery.andWhere('template.industries::text ILIKE :industry', {
        industry: `%${req.query.industry}%`,
      });
    }

    const [data, total] = await Promise.all([
      queryBuilder
        .orderBy('template.createdAt', 'DESC')
        .skip(skip)
        .take(limit)
        .getMany(),
      countQuery.getCount(),
    ]);

    const totalPages = Math.ceil(total / limit);

    // Map to frontend expected format
    const formattedData = data.map(template => ({
      _id: template.id, // Frontend expects _id
      id: template.id,
      content: template.content,
      type: template.type,
      industry: template.industries && template.industries.length > 0 
        ? template.industries[0] 
        : '', // Take first industry or empty string
      industries: template.industries || [],
      skills: template.tech || [], // Map tech to skills for frontend
      tech: template.tech || [],
      used: 0, // TODO: Add tracking for used count
      replied: 0, // TODO: Add tracking for replied count
      succeeded: 0, // TODO: Add tracking for succeeded count
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    }));

    res.json({
      data: formattedData,
      page,
      limit,
      total,
      totalPages,
    });
  } catch (error) {
    console.error('Get message templates error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
