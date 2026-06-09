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

/** Whitelist sort columns for template list endpoints (query params sortBy / sortOrder). */
function parseTemplateListSort(sortBy, sortOrder) {
  const order = String(sortOrder || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const key = String(sortBy || 'createdAt').toLowerCase();
  const columnByKey = {
    used: 'template.usedCount',
    content: 'template.content',
    createdat: 'template.createdAt',
  };
  const column = columnByKey[key] || 'template.createdAt';
  return { column, order };
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

/** Normalize industries/tech from DB simple-array, JSON string, or comma-separated text. */
function normalizeStringListField(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) {
    return value.map((x) => String(x || '').trim()).filter(Boolean);
  }
  const raw = String(value).trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((x) => String(x || '').trim()).filter(Boolean);
      }
    } catch {
      // fall through
    }
  }
  return raw
    .split(/[,;|]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeLeadVariables(lead) {
  return {
    firstName: lead.firstName ?? lead.first_name ?? '',
    companyName: lead.companyName ?? lead.company_name ?? '',
    companyUrl: lead.companyUrl ?? lead.websiteUrl ?? lead.website_url ?? lead.domain ?? '',
    email: lead.email ?? '',
    jobTitle: lead.jobTitle ?? lead.job_title ?? '',
    industries: normalizeStringListField(lead.industries ?? lead.industry),
    tech: normalizeStringListField(lead.tech),
    companyLocation: lead.companyLocation ?? lead.company_location ?? '',
    icebreakerTitle: lead.icebreakerTitle ?? lead.icebreaker_title ?? '',
    icebreaker: lead.icebreaker ?? '',
  };
}

/** Tech stack keywords → template category (curated lead tech field is high trust). */
const TECH_CATEGORY_HINTS = [
  { category: 'E-commerce', patterns: ['shopify', 'woocommerce', 'magento', 'bigcommerce', 'prestashop'] },
  { category: 'Fintech', patterns: ['stripe', 'plaid', 'adyen', 'paypal', 'fintech', 'banking', 'payments'] },
  { category: 'E-learning', patterns: ['moodle', 'canvas', 'teachable', 'thinkific', 'e-learning', 'elearning'] },
  { category: 'CRM', patterns: ['salesforce', 'hubspot', 'zoho crm', 'pipedrive'] },
  { category: 'AI-chatbot', patterns: ['openai', 'chatgpt', 'langchain', 'dialogflow', 'chatbot'] },
  { category: 'AI-healthcare', patterns: ['epic', 'cerner', 'telehealth', 'healthtech'] },
  { category: 'healthcare', patterns: ['medical', 'hospital', 'pharma', 'biotech'] },
  { category: 'petcare', patterns: ['pet care', 'veterinary', 'vet clinic'] },
  { category: 'travel', patterns: ['booking.com', 'amadeus', 'sabre', 'hospitality'] },
  { category: 'mqtt-energy', patterns: ['mqtt', 'iot energy', 'smart grid', 'solar'] },
];

const COMPOSE_MESSAGE_TYPES = new Set(['outreach', 'followup', '2nd-followup']);

/**
 * outreach | followup | 2nd-followup — aligns with {@link selectMessageTemplate} types.
 */
function resolveComposeMessageType(explicit, lead) {
  const norm = (v) =>
    String(v || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/_/g, '-');

  const fromExplicit = norm(explicit);
  if (fromExplicit === '2nd-followup' || fromExplicit === '2ndfollowup') return '2nd-followup';
  if (COMPOSE_MESSAGE_TYPES.has(fromExplicit)) return fromExplicit;

  const fromLead = norm(lead?.messageType ?? lead?.message_type);
  if (fromLead === '2nd-followup' || fromLead === '2ndfollowup') return '2nd-followup';
  if (COMPOSE_MESSAGE_TYPES.has(fromLead)) return fromLead;

  const fu = lead?.isFollowup ?? lead?.is_followup ?? lead?.is_follow_up;
  const status = norm(lead?.status);
  if (fu === true || fu === 1 || status === 'followup' || status === 'follow-up') {
    const stage = Number(lead?.followUpStage ?? lead?.follow_up_stage ?? 0);
    if (stage >= 2) return '2nd-followup';
    return 'followup';
  }

  return 'outreach';
}

function categoryMatchVariants(category) {
  const c = category.toLowerCase();
  return [c, c.replace(/-/g, ' '), c.replace(/-/g, '')].filter((v) => v.length > 1);
}

/**
 * Score how well a category fits lead industries, tech, and company context.
 * Industries and tech from CRM/Apollo are weighted higher than job title/company name hints.
 */
function scoreCategoryForLead(normalizedLead, category) {
  const industries = normalizedLead.industries || [];
  const tech = normalizedLead.tech || [];
  const variants = categoryMatchVariants(category);
  let score = 0;

  for (const raw of industries) {
    const s = String(raw || '').toLowerCase().trim();
    if (!s) continue;
    const c = category.toLowerCase();
    if (s === c || s === category) score += 14;
    else if (s.includes(c) || c.includes(s)) score += 9;
    for (const v of variants) {
      if (v.length > 2 && (s.includes(v) || v.includes(s))) score += 5;
    }
  }

  for (const raw of tech) {
    const s = String(raw || '').toLowerCase().trim();
    if (!s) continue;
    for (const hint of TECH_CATEGORY_HINTS) {
      if (hint.category !== category) continue;
      for (const p of hint.patterns) {
        if (s.includes(p) || p.includes(s)) score += 10;
      }
    }
    const c = category.toLowerCase();
    if (s.includes(c) || c.includes(s)) score += 6;
  }

  const blob = [
    String(normalizedLead.jobTitle || '').toLowerCase(),
    String(normalizedLead.companyName || '').toLowerCase(),
  ].join(' ');
  for (const v of variants) {
    if (v.length > 2 && blob.includes(v)) score += 2;
  }

  return score;
}

/**
 * Map CRM lead industries / tech to a template industry bucket (authoritative when Apollo data exists).
 */
function pickIndustryFromLead(normalizedLead) {
  const hasLeadSignals =
    (normalizedLead.industries?.length || 0) > 0 || (normalizedLead.tech?.length || 0) > 0;

  let best = null;
  let bestScore = 0;

  for (const cat of COMPANY_CATEGORIES) {
    const score = scoreCategoryForLead(normalizedLead, cat);
    if (score > bestScore) {
      bestScore = score;
      best = cat;
    }
  }

  if (best && bestScore >= 4) return best;
  if (best && bestScore > 0 && hasLeadSignals) return best;
  return 'Other';
}

/**
 * Merge website AI classification with lead industries/tech (lead CRM fields are curated and trusted).
 */
function reconcileIndustryClassification({
  aiCategory,
  aiAccuracy,
  aiReasoning,
  normalizedLead,
  websiteSummary,
}) {
  const leadCategory = pickIndustryFromLead(normalizedLead);
  const leadScore = scoreCategoryForLead(normalizedLead, leadCategory);
  const aiScore = scoreCategoryForLead(normalizedLead, aiCategory);
  const websiteText = String(websiteSummary?.combinedText || '').trim();
  const sparseWebsite = websiteText.length < 250;
  const hasLeadData =
    (normalizedLead.industries?.length || 0) > 0 || (normalizedLead.tech?.length || 0) > 0;

  let category = aiCategory;
  let accuracy = aiAccuracy;
  let reasoning = aiReasoning;
  const notes = [];

  if (!hasLeadData) {
    return { category, selectedIndustry: accuracy < 3 ? 'Other' : category, accuracy, reasoning };
  }

  if (leadCategory === aiCategory) {
    accuracy = Math.min(10, Math.max(accuracy, leadScore >= 8 ? 8 : accuracy + 1));
    notes.push(`Lead industries/tech align with website classification (${leadCategory}).`);
  } else if (sparseWebsite && leadScore >= 4) {
    category = leadCategory;
    accuracy = Math.min(10, Math.max(6, Math.floor(leadScore / 2)));
    notes.push('Sparse website content; using lead industries and tech.');
  } else if (leadScore >= 10 && aiAccuracy < 7) {
    category = leadCategory;
    accuracy = Math.min(9, Math.max(accuracy, Math.floor(leadScore / 2)));
    notes.push('Strong lead industry/tech signal overrides low-confidence website guess.');
  } else if (leadScore >= aiScore + 5 && aiAccuracy <= 6) {
    category = leadCategory;
    accuracy = Math.min(8, Math.max(accuracy, Math.floor(leadScore / 2)));
    notes.push('Lead industries/tech fit better than website-only classification.');
  } else if (aiCategory === 'unknown' && leadCategory !== 'Other' && leadScore >= 5) {
    category = leadCategory;
    accuracy = Math.max(accuracy, 5);
    notes.push('Website unclear; applied lead industries/tech.');
  } else if (aiAccuracy >= 8 && aiScore >= leadScore) {
    notes.push(`Website analysis (${aiCategory}) kept; lead data supports or is neutral.`);
  } else if (leadScore >= 6 && aiAccuracy < 5) {
    category = leadCategory;
    accuracy = Math.max(accuracy, 5);
    notes.push('Low website confidence; favored lead industries/tech.');
  }

  const selectedIndustry = accuracy < 3 ? 'Other' : category;
  if (notes.length) {
    const leadCtx = [
      normalizedLead.industries?.length ? `industries: ${normalizedLead.industries.join(', ')}` : '',
      normalizedLead.tech?.length ? `tech: ${normalizedLead.tech.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    reasoning = [reasoning, ...notes, leadCtx ? `Lead data: ${leadCtx}.` : '']
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  return { category, selectedIndustry, accuracy, reasoning };
}

function isOpenAiComposeFallbackError(err) {
  const msg = String(err?.message || err || '');
  const status = err?.status;
  if (status === 503) return true;
  if (status === 401) return true;
  if (status === 429) return true;
  if (status === 400 && /quota|billing|invalid|incorrect|authentication|api key|unauthorized|permission/i.test(msg))
    return true;
  if (
    /not configured|OPEN_AI_API_KEY|OPENAI_API_KEY|incorrect api key|invalid api key|invalid_api_key|quota|billing|insufficient_quota|rate limit|429|timed out|AbortError|fetch failed|ECONNREFUSED/i.test(
      msg
    )
  )
    return true;
  return false;
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

/** Shared compose logic for HTTP handler and marketing send pipeline. */
export async function composeLeadOutboundEmail({
  lead,
  accountName = '',
  accountEmail = '',
  messageType = 'outreach',
  industry = '',
}) {
  if (!lead || typeof lead !== 'object') {
    throw new Error('lead is required');
  }
  const requestedType =
    messageType && typeof messageType === 'string' ? messageType : 'outreach';
  const subjectRepo = AppDataSource.getRepository(Template);
  const subjectTemplate = await selectSubjectTemplate(subjectRepo);
  if (!subjectTemplate) {
    throw new Error('No subject templates found');
  }
  const messageTemplate = await selectMessageTemplate(subjectRepo, requestedType, industry);
  if (!messageTemplate) {
    throw new Error(`No message templates found for type ${requestedType}`);
  }
  const normalizedLead = normalizeLeadVariables(lead);
  const vars = {
    ...normalizedLead,
    senderName: accountName ?? '',
    email: accountEmail ?? '',
  };
  const subject = sanitizeRandomPlaceholders(renderTemplateVariables(subjectTemplate.content, vars));
  const body = sanitizeRandomPlaceholders(renderTemplateVariables(messageTemplate.content, vars));
  await incrementTemplateUsedCount(subjectRepo, subjectTemplate.id);
  await incrementTemplateUsedCount(subjectRepo, messageTemplate.id);
  return {
    subject,
    body,
    template: body,
    industry: industry || '',
    subjectTemplateId: subjectTemplate.id,
    messageTemplateId: messageTemplate.id,
  };
}

export async function composeEmailFromTemplates(req, res) {
  try {
    const { accountName, accountEmail, lead, messageType, industry } = req.body || {};

    if (!lead || typeof lead !== 'object') {
      return res.status(400).json({ error: 'lead is required' });
    }

    const composed = await composeLeadOutboundEmail({
      lead,
      accountName,
      accountEmail,
      messageType,
      industry,
    });

    return res.json({
      subject: composed.subject,
      template: composed.body,
      industry: composed.industry,
      subjectTemplateId: composed.subjectTemplateId,
      messageTemplateId: composed.messageTemplateId,
    });
  } catch (error) {
    if (error.message?.includes('No subject') || error.message?.includes('No message templates')) {
      return res.status(404).json({ error: error.message });
    }
    console.error('composeEmailFromTemplates error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/** AI industry classification + template selection (same pipeline as gmail-extension compose AI). */
export async function composeLeadOutboundEmailWithAi({
  lead,
  accountName = '',
  accountEmail = '',
  messageType,
}) {
  if (!lead || typeof lead !== 'object') {
    throw new Error('lead is required');
  }

  const normalizedLead = normalizeLeadVariables(lead);
  const requestedMessageType = resolveComposeMessageType(messageType, lead);

    let websiteSummary = { sourceUrl: normalizedLead.companyUrl || '', pages: [], combinedText: '' };
    try {
      websiteSummary = await fetchWebsiteContentSummary(normalizedLead.companyUrl);
    } catch {
      // Non-fatal: OpenAI can still classify from lead fields; fallback uses industries only.
    }

    let category = 'unknown';
    let selectedIndustry = 'Other';
    let reasoning = '';
    let accuracy = 0;
    let usedAiClassification = false;

    const applyAiClassification = (parsed) => {
      const rawAccuracy = Number(parsed.accuracy);
      accuracy = Number.isFinite(rawAccuracy) ? rawAccuracy : 0;
      const rawCategory = String(parsed.category || '').trim();
      category = COMPANY_CATEGORIES.includes(rawCategory) ? rawCategory : 'unknown';
      selectedIndustry = accuracy < 3 ? 'Other' : category;
      reasoning = String(parsed.reasoning || '').trim();
      usedAiClassification = true;
    };

    const applyLeadFallback = (reason) => {
      selectedIndustry = pickIndustryFromLead(normalizedLead);
      category = selectedIndustry;
      reasoning = reason;
      accuracy = 0;
      usedAiClassification = false;
    };

    let openAiFailed = false;
    try {
      assertOpenAiConfigured();
      const systemPrompt = [
        'You classify B2B companies into a fixed list of categories for cold-email template selection.',
        'Return only valid JSON with keys: category, reasoning, accuracy.',
        `Allowed categories: ${COMPANY_CATEGORIES.join(', ')}.`,
        'Choose exactly one category from the allowed list.',
        'Use ALL evidence: (1) lead.industries and lead.tech from CRM/Apollo — these are curated and usually correct;',
        '(2) website HTML/text; (3) company name, job title, and URL as secondary hints.',
        'When lead.industries or lead.tech clearly indicate a sector (e.g. "financial services", "e-learning", Shopify stack),',
        'your category must agree unless the website strongly contradicts it.',
        'If website content is sparse or generic, rely more on lead.industries and lead.tech and lower accuracy.',
        'accuracy is 0–10 confidence in the final category.',
        'Do not invent facts not supported by the provided context.',
      ].join(' ');

      const userPrompt = JSON.stringify({
        lead: {
          companyName: normalizedLead.companyName,
          companyUrl: normalizedLead.companyUrl,
          jobTitle: normalizedLead.jobTitle,
          industries: normalizedLead.industries,
          tech: normalizedLead.tech,
          companyLocation: normalizedLead.companyLocation,
        },
        websiteSummary: {
          sourceUrl: websiteSummary.sourceUrl,
          pages: websiteSummary.pages.map((page) => ({
            url: page.url,
            title: page.title,
          })),
          combinedText: websiteSummary.combinedText,
        },
        instructions: {
          goal:
            'Pick one allowed category. Weight lead.industries and lead.tech heavily; use website content to confirm or refine.',
          outputFormat: {
            category: 'one string from the allowed category list',
            reasoning: 'short string explaining website + lead.industries/tech alignment',
            accuracy: 'number 0–10',
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
        try {
          const fenced = raw.match(/\{[\s\S]*\}/);
          parsed = fenced ? JSON.parse(fenced[0]) : null;
        } catch {
          parsed = null;
        }
      }

      if (!parsed || typeof parsed !== 'object') {
        console.warn('[OpenAI] composeAiEmail: unparseable or empty AI JSON; using lead industries.');
        applyLeadFallback('OpenAI returned an unusable response; using lead industries for template selection.');
        openAiFailed = true;
      } else {
        applyAiClassification(parsed);
        if (!openAiFailed) {
          const reconciled = reconcileIndustryClassification({
            aiCategory: category,
            aiAccuracy: accuracy,
            aiReasoning: reasoning,
            normalizedLead,
            websiteSummary,
          });
          category = reconciled.category;
          selectedIndustry = reconciled.selectedIndustry;
          accuracy = reconciled.accuracy;
          reasoning = reconciled.reasoning;
        }
      }
    } catch (error) {
      if (isOpenAiComposeFallbackError(error)) {
        openAiFailed = true;
        const msg = String(error?.message || error || 'OpenAI unavailable');
        applyLeadFallback(
          `OpenAI unavailable (${msg.slice(0, 200)}); using lead industries and message type "${requestedMessageType}".`
        );
        if (/quota|billing|insufficient_quota/i.test(msg)) {
          console.warn(
            '[OpenAI] composeAiEmail: falling back to lead-based industries (quota/billing). Add credits or set OPENAI_API_KEY.'
          );
        } else if (!/quota|billing/i.test(msg)) {
          console.warn('[OpenAI] composeAiEmail: falling back to lead-based industries:', msg.slice(0, 300));
        }
      } else {
        throw error;
      }
    }

    const templateRepository = AppDataSource.getRepository(Template);
    const subjectTemplate = await selectSubjectTemplate(templateRepository);
    if (!subjectTemplate) {
      throw new Error('No subject templates found');
    }

    const messageTemplate = await selectMessageTemplate(
      templateRepository,
      requestedMessageType,
      selectedIndustry
    );
    if (!messageTemplate) {
      throw new Error(`No message templates found for type ${requestedMessageType}`);
    }

    const vars = {
      ...normalizedLead,
      senderName: accountName ?? '',
      email: accountEmail ?? '',
    };

    let subject = renderTemplateVariables(subjectTemplate.content, vars);
    let template = renderTemplateVariables(messageTemplate.content, vars);
    subject = sanitizeRandomPlaceholders(subject);
    template = sanitizeRandomPlaceholders(template);

    await incrementTemplateUsedCount(templateRepository, subjectTemplate.id);
    await incrementTemplateUsedCount(templateRepository, messageTemplate.id);

    return {
      subject,
      body: template,
      template,
      category,
      selectedIndustry,
      reasoning,
      accuracy,
      websitePagesUsed: websiteSummary.pages.map((page) => page.url),
      subjectTemplateId: subjectTemplate.id,
      messageTemplateId: messageTemplate.id,
      messageType: requestedMessageType,
      usedAiClassification,
      openAiFailed,
    };
}

export async function composeAiEmail(req, res) {
  try {
    const { accountName, accountEmail, lead, messageType: bodyMessageType } = req.body || {};
    if (!lead || typeof lead !== 'object') {
      return res.status(400).json({ error: 'lead is required' });
    }

    const result = await composeLeadOutboundEmailWithAi({
      lead,
      accountName,
      accountEmail,
      messageType: bodyMessageType,
    });

    return res.json({
      subject: result.subject,
      template: result.template,
      category: result.category,
      selectedIndustry: result.selectedIndustry,
      reasoning: result.reasoning,
      accuracy: result.accuracy,
      websitePagesUsed: result.websitePagesUsed,
      subjectTemplateId: result.subjectTemplateId,
      messageTemplateId: result.messageTemplateId,
      messageType: result.messageType,
      usedAiClassification: result.usedAiClassification,
      openAiFailed: result.openAiFailed,
    });
  } catch (error) {
    if (error.message?.includes('No subject') || error.message?.includes('No message templates')) {
      return res.status(404).json({ error: error.message });
    }
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

    const { column: sortColumn, order: sortOrderSql } = parseTemplateListSort(
      req.query.sortBy,
      req.query.sortOrder
    );

    const [data, total] = await Promise.all([
      queryBuilder
        .orderBy(sortColumn, sortOrderSql)
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

    const { column: sortColumn, order: sortOrderSql } = parseTemplateListSort(
      req.query.sortBy,
      req.query.sortOrder
    );

    const [data, total] = await Promise.all([
      queryBuilder
        .orderBy(sortColumn, sortOrderSql)
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
