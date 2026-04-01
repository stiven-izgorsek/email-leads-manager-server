import { AppDataSource } from '../config/database.js';
import { Template } from '../entities/Template.js';
import { Like } from 'typeorm';
import { createChatCompletion, assertOpenAiConfigured, getRelevantPortfolioContext } from '../services/applicationService.js';
import { fetchWebsiteContentSummary } from '../services/websiteContentService.js';

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

export async function composeAiEmail(req, res) {
  try {
    assertOpenAiConfigured();

    const { accountName, accountEmail, lead, type } = req.body || {};
    if (!lead || typeof lead !== 'object') {
      return res.status(400).json({ error: 'lead is required' });
    }

    const normalizedLead = {
      firstName: lead.firstName ?? lead.first_name ?? '',
      companyName: lead.companyName ?? lead.company_name ?? '',
      companyUrl: lead.companyUrl ?? lead.websiteUrl ?? lead.website_url ?? lead.domain ?? '',
      email: lead.email ?? '',
      jobTitle: lead.jobTitle ?? lead.job_title ?? '',
      industries: Array.isArray(lead.industries) ? lead.industries : [],
      tech: Array.isArray(lead.tech) ? lead.tech : [],
      companyLocation: lead.companyLocation ?? lead.company_location ?? '',
      icebreakerTitle: lead.icebreakerTitle ?? lead.icebreaker_title ?? '',
      icebreaker: lead.icebreaker ?? '',
    };

    const websiteSummary = await fetchWebsiteContentSummary(normalizedLead.companyUrl);
    const portfolioContext = getRelevantPortfolioContext(
      [
        normalizedLead.companyName,
        normalizedLead.companyUrl,
        normalizedLead.industries.join(' '),
        normalizedLead.tech.join(' '),
        normalizedLead.jobTitle,
      ].filter(Boolean).join(' '),
      { maxSections: 3, maxChars: 5000 }
    );

    const systemPrompt = [
      'You generate short personalized cold outreach emails.',
      'Return only valid JSON.',
      'The JSON must have keys: subject, template, reasoning, accuracy.',
      'The email must be concise, natural, and personalized to the company.',
      'The sender is an individual developer looking for a new opportunity, mainly focused on software engineering roles.',
      'Generate different message styles, not the same structure every time.',
      'If the caller passes type="long", use the longer structure. If type="short", use the shorter structure. If no type is specified, choose randomly between them.',
      'Long structure usually includes: why the sender came across the company/person, what interests the sender about the product/feature/business, relevant similar experience from previous work, and eagerness to contribute to the team.',
      'Short structure usually includes: who the sender is, closely matching industry/technology experience, and openness to chat if there is a fit.',
      'Do not invent facts not supported by the website/company context.',
      'If website context is weak, fall back to company name and lead details only.',
      'Keep the subject under 90 characters.',
      'Keep the message under 1200 characters.',
      'The message should be plain text and can include line breaks.',
      'Use "your company" when company name is missing.',
      'Do not mention any domain links, URLs, website addresses, or project names from the portfolio context in the first message.',
      'Do not use opening lines like "I hope this message finds you well" or similar.',
      'Do not use phrases like "I recently came across..." or "I was very impressed..." in the message.',
      'A simple natural greeting at the beginning is fine, for example "Hi John," or "Hello John,".',
      'You may use the portfolio context only to infer relevant experience domains and capability fit, not to name-drop projects.',
      'Add an emoticon to the subject only occasionally, roughly around 1 out of 3 messages, and at most one emoticon when you do.',
    ].join(' ');

    const userPrompt = JSON.stringify({
      sender: {
        accountName: accountName || '',
        accountEmail: accountEmail || '',
      },
      lead: normalizedLead,
      websiteSummary: {
        sourceUrl: websiteSummary.sourceUrl,
        pages: websiteSummary.pages.map((page) => ({
          url: page.url,
          title: page.title,
        })),
        combinedText: websiteSummary.combinedText,
      },
      portfolioContext,
      instructions: {
        goal: 'Generate a tailored first outreach email to this lead based on their company website and company context.',
        senderPositioning: 'The sender is an individual developer exploring new opportunities, mainly focused on software engineering.',
        requestedType: type || 'random',
        messageTypes: {
          long: {
            description: 'A bit longer style',
            structure: [
              'why I came across your company or you',
              'what I am interested about your product/feature/business',
              'I have experiences to build similar products/features/business logic in previous projects',
              'I am eager to contribute to your team',
            ],
          },
          short: {
            description: 'A bit shorter style',
            structure: [
              'who I am',
              'I have experiences in similar industries/technologies',
              'open to chat if there is a fit',
            ],
          },
        },
        styleReferences: [
          "I'm reaching out to inquire about potential job openings at your company, particularly in Software Development. I would be excited to learn more about any current or upcoming opportunities.",
          "With over 10 years of experience, I've specialized in building high-performance applications across Healthcare IoT, AI, e-Commerce, e-learning, FinTech, CRM, and SaaS platforms. My expertise includes working with programming languages like JavaScript/TypeScript, Python, and PHP for both frontend and backend development.",
          "I'd love the chance to explore how my skills and experience could contribute to your team. Please let me know if there are any opportunities available—I'd be happy to discuss further.",
          "I came across your website and wanted to reach out directly. I'm a Senior Software Engineer currently exploring new opportunities and would love to be considered if you have any open or upcoming roles.",
          "My background includes SaaS, Fintech, Healthcare, eCommerce, and AI projects, working mainly with JavaScript/TypeScript, Python, and PHP. I enjoy building scalable products and contributing to teams that value clean, reliable software.",
          "If relevant, I'd be happy to share my CV and portfolio."
        ],
        outputFormat: {
          subject: 'string',
          template: 'string',
          reasoning: 'short string',
          accuracy: 'number from 0 to 10 indicating how accurate/relevant the generated message is for this company and lead',
        },
      },
    });

    const raw = await createChatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const fenced = raw.match(/\{[\s\S]*\}/);
      parsed = fenced ? JSON.parse(fenced[0]) : null;
    }

    if (!parsed || typeof parsed !== 'object') {
      return res.status(502).json({ error: 'Invalid AI response format' });
    }

    return res.json({
      subject: String(parsed.subject || '').trim(),
      template: String(parsed.template || '').trim(),
      reasoning: String(parsed.reasoning || '').trim(),
      accuracy: Number.isFinite(Number(parsed.accuracy)) ? Number(parsed.accuracy) : 0,
      websitePagesUsed: websiteSummary.pages.map((page) => page.url),
    });
  } catch (error) {
    console.error('composeAiEmail error:', error);
    return res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
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
