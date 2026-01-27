import { AppDataSource } from '../config/database.js';
import { Template } from '../entities/Template.js';
import { Like } from 'typeorm';

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
