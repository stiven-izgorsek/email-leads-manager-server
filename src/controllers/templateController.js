import { AppDataSource } from '../config/database.js';
import { Template } from '../entities/Template.js';
import { Like } from 'typeorm';
import { createChatCompletion, assertOpenAiConfigured } from '../services/applicationService.js';
import { fetchWebsiteContentSummary } from '../services/websiteContentService.js';

const COMPANY_CATEGORIES = [
  'AI-image',
  'AI-chatbot',
  'AI-healthcare',
  'AI-automation',
  'AI-audio',
  'AI-CRM',
  'AI-unknown',
  'CRM',
  'E-commerce',
  'E-learning',
  'Fintech',
  'Document-generation',
  'healthcare',
  'petcare',
  'manufacturing-furniture',
  'manufacturing-pump',
  'manufacturing-unknown',
  'mqtt-energy',
  'travel',
  'unknown',
];

const TEMPLATE_INDUSTRIES = [
  ...COMPANY_CATEGORIES,
  'Other',
];

const TEMPLATE_SIZES = ['long', 'short', 'normal'];

/** Gmail extension / compose endpoints only pick message templates of these sizes (exclude short). */
const BOT_MESSAGE_TEMPLATE_SIZE_SQL = "(COALESCE(template.size, 'normal') IN ('normal', 'long'))";

const INDUSTRY_GENERATION_NOTES = {
  petcare:
    'The industry key "petcare" means pet care: products and services for pets\' health, wellbeing, and daily needs—analogous to healthcare, but for companion animals.',
  healthcare: 'Human healthcare, medical, wellness, or patient-facing health technology and services.',
};

function sanitizeRandomPlaceholders(templateContent) {
  if (typeof templateContent !== 'string') return templateContent;
  // Some models output a trailing pipe right before the closing braces:
  // {{RANDOM|opt1|opt2|}}  -> {{RANDOM|opt1|opt2}}
  return templateContent.replace(
    /{{RANDOM\s*\|([\s\S]*?)\|\s*}}/gi,
    (_match, optionsRaw) => `{{RANDOM|${String(optionsRaw).trim()}}}`
  );
}

async function incrementTemplateUsedCount(templateRepository, id) {
  if (!id) return;
  try {
    await templateRepository.increment({ id }, 'usedCount', 1);
  } catch (err) {
    console.warn('incrementTemplateUsedCount failed:', id, err?.message || err);
  }
}

async function findMessageTemplateForIndustryAndSize(templateRepository, messageType, industry, size) {
  return templateRepository
    .createQueryBuilder('template')
    .where('template.deletedAt IS NULL')
    .andWhere('template.type = :type', { type: messageType })
    .andWhere("COALESCE(template.size, 'normal') = :size", { size })
    .andWhere(
      `(
        template.industries = :industryExact
        OR template.industries LIKE :industryPrefix
        OR template.industries LIKE :industryMiddle
        OR template.industries LIKE :industrySuffix
      )`,
      {
        industryExact: industry,
        industryPrefix: `${industry},%`,
        industryMiddle: `%,${industry},%`,
        industrySuffix: `%,${industry}`,
      }
    )
    .orderBy('template.createdAt', 'ASC')
    .getOne();
}

function normalizeLeadVariables(lead) {
  return {
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
}

async function selectSubjectTemplate(templateRepository) {
  return templateRepository.createQueryBuilder('template')
    .where('template.deletedAt IS NULL')
    .andWhere('template.type = :type', { type: 'subject' })
    .orderBy('RANDOM()')
    .take(1)
    .getOne();
}

async function selectMessageTemplate(templateRepository, requestedType, industry) {
  const preferredIndustry = String(industry || '').trim();
  if (preferredIndustry) {
    const industryTemplate = await templateRepository.createQueryBuilder('template')
      .where('template.deletedAt IS NULL')
      .andWhere("template.type IN ('outreach', 'followup', '2nd-followup')")
      .andWhere('template.type = :type', { type: requestedType })
      .andWhere(BOT_MESSAGE_TEMPLATE_SIZE_SQL)
      .andWhere('template.industries::text ILIKE :industry', { industry: `%${preferredIndustry}%` })
      .orderBy('RANDOM()')
      .take(1)
      .getOne();
    if (industryTemplate) return industryTemplate;
  }

  if (preferredIndustry.toLowerCase() !== 'other') {
    const otherTemplate = await templateRepository.createQueryBuilder('template')
      .where('template.deletedAt IS NULL')
      .andWhere("template.type IN ('outreach', 'followup', '2nd-followup')")
      .andWhere('template.type = :type', { type: requestedType })
      .andWhere(BOT_MESSAGE_TEMPLATE_SIZE_SQL)
      .andWhere('template.industries::text ILIKE :industry', { industry: '%Other%' })
      .orderBy('RANDOM()')
      .take(1)
      .getOne();
    if (otherTemplate) return otherTemplate;
  }

  return templateRepository.createQueryBuilder('template')
    .where('template.deletedAt IS NULL')
    .andWhere("template.type IN ('outreach', 'followup', '2nd-followup')")
    .andWhere('template.type = :type', { type: requestedType })
    .andWhere(BOT_MESSAGE_TEMPLATE_SIZE_SQL)
    .orderBy('RANDOM()')
    .take(1)
    .getOne();
}

function renderTemplateVariables(template, vars) {
  if (typeof template !== 'string' || !template.length) return '';

  // Handle RANDOM selections: {{RANDOM|option1|option2|option3}}
  // IMPORTANT: options may include other placeholders like {{companyName}},
  // so we cannot use a naive regex that stops at the first `}`.
  const replaceRandomBlocks = (input) => {
    if (typeof input !== 'string') return input;

    let out = '';
    const lower = input.toLowerCase();
    let i = 0;

    while (i < input.length) {
      const idx = lower.indexOf('{{random', i);
      if (idx === -1) {
        out += input.slice(i);
        break;
      }

      // Append everything before the RANDOM block
      out += input.slice(i, idx);

      const startMatch = input.slice(idx).match(/^{{\s*random\s*\|/i);
      if (!startMatch) {
        i = idx + 2;
        continue;
      }

      const startContent = idx + startMatch[0].length;

      // Find the matching closing `}}` for this RANDOM block.
      // Track nested `{{...}}` so `{{companyName}}` inside options doesn't break parsing.
      let j = startContent;
      let depth = 1;

      while (j < input.length - 1) {
        if (input[j] === '{' && input[j + 1] === '{') {
          depth += 1;
          j += 2;
          continue;
        }
        if (input[j] === '}' && input[j + 1] === '}') {
          depth -= 1;
          if (depth === 0) break;
          j += 2;
          continue;
        }
        j += 1;
      }

      if (depth !== 0) {
        // Unmatched RANDOM block; keep remainder unchanged.
        out += input.slice(idx);
        break;
      }

      const blockEndIdx = j; // points at the first of the closing '}}'
      const endIdx = j + 2;
      const optionsRaw = input.slice(startContent, blockEndIdx);

      const choices = String(optionsRaw || '')
        .split('|')
        .map((opt) => opt.trim())
        .filter(Boolean);

      if (choices.length === 0) {
        i = endIdx;
        continue;
      }

      out += choices[Math.floor(Math.random() * choices.length)];
      i = endIdx;
    }

    return out;
  };

  let result = replaceRandomBlocks(template);

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
    const { accountName, accountEmail, lead, messageType, industry } = req.body || {};
    const requestedType = messageType && typeof messageType === 'string' ? messageType : 'outreach';

    if (!lead || typeof lead !== 'object') {
      return res.status(400).json({ error: 'lead is required' });
    }

    const subjectRepo = AppDataSource.getRepository(Template);

    const subjectTemplate = await selectSubjectTemplate(subjectRepo);

    if (!subjectTemplate) {
      return res.status(404).json({ error: 'No subject templates found' });
    }

    const messageTemplate = await selectMessageTemplate(subjectRepo, requestedType, industry);

    if (!messageTemplate) {
      return res.status(404).json({ error: `No message templates found for type ${requestedType}` });
    }

    const normalizedLead = normalizeLeadVariables(lead);

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

    await incrementTemplateUsedCount(subjectRepo, subjectTemplate.id);
    await incrementTemplateUsedCount(subjectRepo, messageTemplate.id);

    return res.json({
      subject,
      template,
      industry: industry || '',
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

    const { accountName, accountEmail, lead } = req.body || {};
    if (!lead || typeof lead !== 'object') {
      return res.status(400).json({ error: 'lead is required' });
    }

    const normalizedLead = normalizeLeadVariables(lead);

    const websiteSummary = await fetchWebsiteContentSummary(normalizedLead.companyUrl);

    const systemPrompt = [
      'You classify companies into a fixed list of categories based on their website HTML/text content.',
      'Return only valid JSON.',
      'The JSON must have keys: category, reasoning, accuracy.',
      `Allowed categories: ${COMPANY_CATEGORIES.join(', ')}.`,
      'Choose exactly one category from the allowed list.',
      'Do not invent facts not supported by the website/company context.',
      'Base the decision mainly on website HTML/text content.',
      'Use accuracy as a number from 0 to 10 indicating confidence in the chosen category.',
      'If the website content is sparse or unclear, use a lower accuracy and choose the closest unknown category when appropriate.',
    ].join(' ');

    const userPrompt = JSON.stringify({
      lead: normalizedLead,
      websiteSummary: {
        sourceUrl: websiteSummary.sourceUrl,
        pages: websiteSummary.pages.map((page) => ({
          url: page.url,
          title: page.title,
        })),
        combinedText: websiteSummary.combinedText,
      },
      instructions: {
        goal: 'Classify this company into one allowed category using the website content.',
        outputFormat: {
          category: 'one string from the allowed category list',
          reasoning: 'short string',
          accuracy: 'number from 0 to 10 indicating how confident the classification is',
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

    const rawAccuracy = Number(parsed.accuracy);
    const accuracy = Number.isFinite(rawAccuracy) ? rawAccuracy : 0;
    const rawCategory = String(parsed.category || '').trim();
    const category = COMPANY_CATEGORIES.includes(rawCategory) ? rawCategory : 'unknown';
    const selectedIndustry = accuracy < 3 ? 'Other' : category;

    const templateRepository = AppDataSource.getRepository(Template);
    const subjectTemplate = await selectSubjectTemplate(templateRepository);
    if (!subjectTemplate) {
      return res.status(404).json({ error: 'No subject templates found' });
    }

    const messageTemplate = await selectMessageTemplate(templateRepository, 'outreach', selectedIndustry);
    if (!messageTemplate) {
      return res.status(404).json({ error: 'No message templates found for outreach' });
    }

    const vars = {
      ...normalizedLead,
      senderName: accountName ?? '',
      email: accountEmail ?? '',
    };

    const subject = renderTemplateVariables(subjectTemplate.content, vars);
    const template = renderTemplateVariables(messageTemplate.content, vars);

    await incrementTemplateUsedCount(templateRepository, subjectTemplate.id);
    await incrementTemplateUsedCount(templateRepository, messageTemplate.id);

    return res.json({
      subject,
      template,
      category,
      selectedIndustry,
      reasoning: String(parsed.reasoning || '').trim(),
      accuracy,
      websitePagesUsed: websiteSummary.pages.map((page) => page.url),
      subjectTemplateId: subjectTemplate.id,
      messageTemplateId: messageTemplate.id,
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
      used: template.usedCount ?? 0,
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
    const { content, size } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }

    const templateRepository = AppDataSource.getRepository(Template);

    const template = templateRepository.create({
      content: content.trim(),
      type: 'subject',
      tech: null,
      industries: null,
      size: size && TEMPLATE_SIZES.includes(size) ? size : 'normal',
    });

    const savedTemplate = await templateRepository.save(template);

    // Format response to match frontend expectations
    const formattedData = {
      _id: savedTemplate.id,
      id: savedTemplate.id,
      content: savedTemplate.content,
      size: savedTemplate.size || 'normal',
      used: savedTemplate.usedCount ?? 0,
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
    const { content, type, industries, tech, size } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }

    if (!type || !['outreach', 'followup', '2nd-followup'].includes(type)) {
      return res.status(400).json({ error: 'Valid type is required (outreach, followup, 2nd-followup)' });
    }

    const normalizedIndustries = Array.isArray(industries)
      ? industries.filter(Boolean)
      : (industries ? [industries] : []);

    const invalidIndustries = normalizedIndustries.filter((industry) => !TEMPLATE_INDUSTRIES.includes(industry));
    if (invalidIndustries.length > 0) {
      return res.status(400).json({
        error: `Invalid industries: ${invalidIndustries.join(', ')}. Allowed industries: ${TEMPLATE_INDUSTRIES.join(', ')}`
      });
    }

    if (size && !TEMPLATE_SIZES.includes(size)) {
      return res.status(400).json({
        error: `Invalid size: ${size}. Allowed sizes: ${TEMPLATE_SIZES.join(', ')}`
      });
    }

    const templateRepository = AppDataSource.getRepository(Template);

    const template = templateRepository.create({
      content: content.trim(),
      type: type,
      tech: Array.isArray(tech) ? tech : (tech ? [tech] : null),
      industries: normalizedIndustries.length > 0 ? normalizedIndustries : null,
      size: size || 'normal',
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
      size: savedTemplate.size || 'normal',
      skills: savedTemplate.tech || [],
      tech: savedTemplate.tech || [],
      used: savedTemplate.usedCount ?? 0,
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

export async function updateMessageTemplate(req, res) {
  try {
    const { id } = req.params;
    const { content, type, industries, tech, size } = req.body;

    if (!id) {
      return res.status(400).json({ error: 'Template id is required' });
    }

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }

    if (!type || !['outreach', 'followup', '2nd-followup'].includes(type)) {
      return res.status(400).json({ error: 'Valid type is required (outreach, followup, 2nd-followup)' });
    }

    const normalizedIndustries = Array.isArray(industries)
      ? industries.filter(Boolean)
      : (industries ? [industries] : []);

    const invalidIndustries = normalizedIndustries.filter((industry) => !TEMPLATE_INDUSTRIES.includes(industry));
    if (invalidIndustries.length > 0) {
      return res.status(400).json({
        error: `Invalid industries: ${invalidIndustries.join(', ')}. Allowed industries: ${TEMPLATE_INDUSTRIES.join(', ')}`
      });
    }

    if (size && !TEMPLATE_SIZES.includes(size)) {
      return res.status(400).json({
        error: `Invalid size: ${size}. Allowed sizes: ${TEMPLATE_SIZES.join(', ')}`
      });
    }

    const templateRepository = AppDataSource.getRepository(Template);
    const existing = await templateRepository.findOne({
      where: { id, deletedAt: null },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Message template not found' });
    }

    existing.content = content.trim();
    existing.type = type;
    existing.tech = Array.isArray(tech) ? tech : (tech ? [tech] : null);
    existing.industries = normalizedIndustries.length > 0 ? normalizedIndustries : null;
    existing.size = size || 'normal';

    const savedTemplate = await templateRepository.save(existing);

    return res.json({
      _id: savedTemplate.id,
      id: savedTemplate.id,
      content: savedTemplate.content,
      type: savedTemplate.type,
      industry: savedTemplate.industries && savedTemplate.industries.length > 0
        ? savedTemplate.industries[0]
        : '',
      industries: savedTemplate.industries || [],
      size: savedTemplate.size || 'normal',
      skills: savedTemplate.tech || [],
      tech: savedTemplate.tech || [],
      used: savedTemplate.usedCount ?? 0,
      replied: 0,
      succeeded: 0,
      createdAt: savedTemplate.createdAt,
      updatedAt: savedTemplate.updatedAt,
    });
  } catch (error) {
    console.error('Update message template error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function generateMessageTemplates(req, res) {
  try {
    assertOpenAiConfigured();

    const { industries, type, overwrite } = req.body || {};
    const requestedType = type && ['outreach', 'followup', '2nd-followup'].includes(type) ? type : 'outreach';
    const shouldOverwrite = Boolean(overwrite);
    const selectedIndustries = Array.isArray(industries) ? industries.filter(Boolean) : [];

    if (selectedIndustries.length === 0) {
      return res.status(400).json({ error: 'industries is required' });
    }

    const invalidIndustries = selectedIndustries.filter((industry) => !TEMPLATE_INDUSTRIES.includes(industry));
    if (invalidIndustries.length > 0) {
      return res.status(400).json({
        error: `Invalid industries: ${invalidIndustries.join(', ')}. Allowed industries: ${TEMPLATE_INDUSTRIES.join(', ')}`
      });
    }

    const templateRepository = AppDataSource.getRepository(Template);
    const createdTemplates = [];

    for (const industry of selectedIndustries) {
      const systemPrompt = [
        'You generate cold outreach message templates for a software engineer job-seeker.',
        'Return only valid JSON.',
        'The JSON must have a key "templates" containing exactly 3 templates.',
        'Generate one template each for sizes: short, normal, long.',
        'Each template must include keys: size, content.',
        'Use placeholders like {{firstName}}, {{companyName}}, and {{senderName}}.',
        'Do not use {{icebreakerTitle}} or {{icebreaker}} placeholders.',
        'Placeholder syntax must be exact. Do not put any extra words inside placeholders. Use exactly {{companyName}} (never {{companyName is ...}}).',
        'Do not nest placeholders inside {{RANDOM|...}}; only the randomized opener sentences should be inside the RANDOM block.',
        'Every template must start with "Hi {{firstName}},".',
        'Immediately after that greeting line, include exactly one {{RANDOM|...}} block for the opener/greeting content (the "why I reached out" part).',
        'The {{RANDOM|...}} block must contain exactly 3 alternative opener sentences tailored to the selected industry.',
        'Each of the 3 alternative opener sentences must be different from the others (not repeated verbatim).',
        'Do NOT reuse the same three opener sentences across short/normal/long; vary the opener options per template.',
        'For RANDOM blocks, use exactly: {{RANDOM|option1|option2|option3}} (no trailing "|" before "}}").',
        'Do not use emoji.',
        'Do not mention project names or URLs.',
        'Never use phrases like "I hope this message finds you well", "hope you are well", or similar generic well-wishing openers.',
        'Prefer a simple direct greeting such as "Hi {{firstName}}," followed by the body.',
        'Keep the templates reusable for the specified industry.',
      ].join(' ');

      const industryNote = INDUSTRY_GENERATION_NOTES[industry] || '';

      const userPrompt = JSON.stringify({
        type: requestedType,
        industry,
        industryNote,
        outputRequirements: {
          count: 3,
          sizes: ['short', 'normal', 'long'],
          styleExample: [
            'Hi {{firstName}},',
            '',
            '{{RANDOM|<opener option 1>|<opener option 2>|<opener option 3>}}',
            '',
            'I’ve been working as a Software Engineer on AI-driven applications, including systems focused on user-facing healthcare experiences.',
            '',
            'If that aligns with anything at {{companyName}}, happy to connect.',
            '',
            'Best,',
            '{{senderName}}'
          ].join('\n'),
          instructions: [
            'Generate templates appropriate for the selected industry.',
            'If industryNote is non-empty, follow it when shaping relevance and vocabulary.',
            'Short = concise, Normal = balanced, Long = more detailed.',
            'The sender is an individual developer exploring software engineering opportunities.',
            'Templates should sound like outreach for potential roles or collaboration around building the right product.',
            'Do not use "I hope this message finds you well" or close variants.',
            'Replace the literal placeholders "<opener option 1/2/3>" with real, industry-specific opener sentences.',
            'The opener sentences inside {{RANDOM|...}} must be the “why I reached out / what I’m interested in” lines, and should be different across each template size.',
          ],
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

      if (!parsed || !Array.isArray(parsed.templates)) {
        return res.status(502).json({ error: `Invalid AI response format while generating templates for ${industry}` });
      }

      for (const item of parsed.templates) {
        const size = String(item?.size || '').trim();
        const rawContent = String(item?.content || '').trim();
        const content = sanitizeRandomPlaceholders(rawContent);

        if (!TEMPLATE_SIZES.includes(size) || !content) {
          continue;
        }

        let savedTemplate;
        let replaced = false;

        if (shouldOverwrite) {
          const existing = await findMessageTemplateForIndustryAndSize(
            templateRepository,
            requestedType,
            industry,
            size
          );
          if (existing) {
            existing.content = content;
            existing.type = requestedType;
            existing.industries = [industry];
            existing.tech = null;
            existing.size = size;
            savedTemplate = await templateRepository.save(existing);
            replaced = true;
          }
        }

        if (!savedTemplate) {
          const template = templateRepository.create({
            content,
            type: requestedType,
            industries: [industry],
            tech: null,
            size,
          });
          savedTemplate = await templateRepository.save(template);
        }

        createdTemplates.push({
          _id: savedTemplate.id,
          id: savedTemplate.id,
          content: savedTemplate.content,
          type: savedTemplate.type,
          industry,
          industries: savedTemplate.industries || [industry],
          size: savedTemplate.size || 'normal',
          skills: savedTemplate.tech || [],
          tech: savedTemplate.tech || [],
          used: savedTemplate.usedCount ?? 0,
          replied: 0,
          succeeded: 0,
          createdAt: savedTemplate.createdAt,
          updatedAt: savedTemplate.updatedAt,
          replaced,
        });
      }
    }

    return res.status(201).json({
      count: createdTemplates.length,
      overwrite: shouldOverwrite,
      data: createdTemplates,
    });
  } catch (error) {
    console.error('Generate message templates error:', error);
    return res.status(error.status || 500).json({ error: error.message || 'Internal server error' });
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

    if (req.query.size) {
      queryBuilder.andWhere('template.size = :size', { size: req.query.size });
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

    if (req.query.size) {
      countQuery.andWhere('template.size = :size', { size: req.query.size });
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
      size: template.size || 'normal',
      skills: template.tech || [], // Map tech to skills for frontend
      tech: template.tech || [],
      used: template.usedCount ?? 0,
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
