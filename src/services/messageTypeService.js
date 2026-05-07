import { AppDataSource } from '../config/database.js';
import { MessageTypeRule } from '../entities/MessageTypeRule.js';
import { createChatCompletion } from './applicationService.js';

/** Default order when several types could match: earlier types win over later ones. */
const TYPE_ORDER = ['blocked', 'ooo', 'bad', 'no_job', 'interest', 'other'];

export const DEFAULT_MESSAGE_TYPE_RULES = [
  { type: 'blocked', pattern: 'message blocked' },
  { type: 'blocked', pattern: 'address not found' },
  { type: 'blocked', pattern: 'message not delivered' },
  { type: 'blocked', pattern: 'delivery has failed' },
  { type: 'blocked', pattern: 'delivery status notification' },
  { type: 'blocked', pattern: 'mail delivery subsystem' },
  { type: 'blocked', pattern: 'returned mail' },

  { type: 'ooo', pattern: 'out of office' },
  { type: 'ooo', pattern: 'i am not in office' },
  { type: 'ooo', pattern: 'i am on vacation' },
  { type: 'ooo', pattern: 'on leave' },
  { type: 'ooo', pattern: 'on holiday' },
  { type: 'ooo', pattern: 'automatic reply' },
  { type: 'ooo', pattern: 'auto-reply' },

  { type: 'bad', pattern: 'unsubscribe' },
  { type: 'bad', pattern: 'not interested' },
  { type: 'bad', pattern: 'not interest' },
  { type: 'bad', pattern: 'stop emailing' },
  { type: 'bad', pattern: 'stop sending' },
  { type: 'bad', pattern: 'go away' },
  { type: 'bad', pattern: 'remove me' },

  { type: 'no_job', pattern: 'no vacancies' },
  { type: 'no_job', pattern: 'no openings' },
  { type: 'no_job', pattern: 'no opportunities' },
  { type: 'no_job', pattern: 'no roles' },
  { type: 'no_job', pattern: 'not hiring' },
  { type: 'no_job', pattern: 'hiring freeze' },

  { type: 'interest', pattern: 'send me cv' },
  { type: 'interest', pattern: 'share cv' },
  { type: 'interest', pattern: 'send your cv' },
  { type: 'interest', pattern: 'where are you based' },
  { type: 'interest', pattern: 'where are you located' },
  { type: 'interest', pattern: 'hourly rate' },
  { type: 'interest', pattern: 'what is your rate' },
];

let seededDefaults = false;

export function normalizeTextForClassification(input) {
  return String(input || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function typeRank(type) {
  const i = TYPE_ORDER.indexOf(String(type || '').toLowerCase());
  return i === -1 ? TYPE_ORDER.length + 100 : i;
}

function sortRulesForClassification(rules) {
  return [...rules].sort((a, b) => {
    const ra = typeRank(a.type);
    const rb = typeRank(b.type);
    if (ra !== rb) return ra - rb;
    const da = new Date(a.createdAt || 0).getTime();
    const db = new Date(b.createdAt || 0).getTime();
    return da - db;
  });
}

function getAllowedTypesFromRules(rules) {
  const unique = new Set(
    (Array.isArray(rules) ? rules : [])
      .map((r) => String(r?.type || '').trim().toLowerCase())
      .filter(Boolean)
  );
  unique.add('other');
  return Array.from(unique);
}

function safeJsonParse(input) {
  try {
    return JSON.parse(input);
  } catch {
    const fenced = String(input || '').match(/\{[\s\S]*\}/);
    if (!fenced) return null;
    try {
      return JSON.parse(fenced[0]);
    } catch {
      return null;
    }
  }
}

function trimForAi(input, maxLen = 3000) {
  const text = String(input || '').trim();
  if (!text) return '';
  return text.length <= maxLen ? text : text.slice(0, maxLen);
}

const JOB_PLATFORM_PATTERNS = [
  /\bjobs?\s+from\b/i,
  /\bdynamic\s+jobs?\b/i,
  /\bjob\s+alerts?\b/i,
  /\bnew\s+jobs?\s+for\s+you\b/i,
  /\brecommended\s+jobs?\b/i,
  /\blinkedin\b/i,
  /\bindeed\b/i,
  /\bglassdoor\b/i,
  /\bziprecruiter\b/i,
  /\bmonster\b/i,
  /\bwelfound\b/i,
  /\bgreenhouse\b/i,
  /\blever\b/i,
];

const DELIVERY_FAILURE_PATTERNS = [
  /\baddress\s+not\s+found\b/i,
  /\bmessage\s+blocked\b/i,
  /\bmessage\s+not\s+delivered\b/i,
  /\bdelivery\s+has\s+failed\b/i,
  /\bdelivery\s+status\s+notification\b/i,
  /\bmail\s+delivery\s+subsystem\b/i,
  /\breturned\s+mail\b/i,
  /\bundeliverable\b/i,
  /\bbounce\b/i,
];

const AUTO_ACKNOWLEDGEMENT_PATTERNS = [
  /\bwe(?:'ve| have)\s+received\s+your\s+message\b/i,
  /\byour\s+message\s+has\s+been\s+received\b/i,
  /\bthank\s+you\s+for\s+reaching\s+out\b/i,
  /\bthank\s+you\s+for\s+sharing\s+your\s+details\b/i,
  /\bone\s+of\s+our\s+team\s+members?\s+will\s+get\s+back\s+to\s+you\b/i,
  /\bour\s+team\s+will\s+get\s+in\s+touch\s+with\s+you\b/i,
  /\bplease\s+don'?t\s+reply\s+to\s+this\s+email\b/i,
  /\bno-?reply\s+inbox\b/i,
  /\bthank\s+you\s+for\s+submitting\s+your\s+profile\b/i,
  /\bwe\s+will\s+review\s+it\s+as\s+soon\s+as\s+possible\b/i,
  /\bthere\s+has\s+been\s+an\s+enquiry\s+form\s+completed\b/i,
  /\bthe\s+details\s+are\s+as\s+follows\b/i,
];

function classifyByPrefilter({ subject, body, fromEmail, toEmail }) {
  const text = `${subject || ''}\n${body || ''}\n${fromEmail || ''}\n${toEmail || ''}`;
  if (DELIVERY_FAILURE_PATTERNS.some((rx) => rx.test(text))) {
    return {
      messageType: 'blocked',
      matchedRules: [],
      prefiltered: 'delivery_failure',
    };
  }
  if (JOB_PLATFORM_PATTERNS.some((rx) => rx.test(text))) {
    return {
      messageType: 'other',
      matchedRules: [],
      prefiltered: 'job_platform',
    };
  }
  if (AUTO_ACKNOWLEDGEMENT_PATTERNS.some((rx) => rx.test(text))) {
    return {
      messageType: 'other',
      matchedRules: [],
      prefiltered: 'auto_acknowledgement',
    };
  }
  return null;
}

export async function ensureDefaultMessageTypeRules() {
  if (seededDefaults) return;
  const repo = AppDataSource.getRepository(MessageTypeRule);
  const existingCount = await repo.count();
  if (existingCount === 0) {
    for (const rule of DEFAULT_MESSAGE_TYPE_RULES) {
      await repo.save(repo.create(rule));
    }
  }
  seededDefaults = true;
}

export async function loadMessageTypeRules() {
  const repo = AppDataSource.getRepository(MessageTypeRule);
  return repo.find({
    order: { createdAt: 'ASC' },
  });
}

async function classifyIncomingMessageWithAi({ subject, body, fromEmail, toEmail, rules = [] }) {
  const normalizedSubject = trimForAi(normalizeTextForClassification(subject), 700);
  const normalizedBody = trimForAi(normalizeTextForClassification(body), 3000);
  const normalizedFrom = trimForAi(normalizeTextForClassification(fromEmail), 300);
  const normalizedTo = trimForAi(normalizeTextForClassification(toEmail), 300);
  const allowedTypes = getAllowedTypesFromRules(rules);

  const rulesByType = {};
  for (const rule of rules) {
    const type = String(rule?.type || '').trim().toLowerCase();
    const pattern = String(rule?.pattern || '').trim();
    if (!type || !pattern) continue;
    if (!rulesByType[type]) rulesByType[type] = [];
    if (rulesByType[type].length < 20) rulesByType[type].push(pattern);
  }

  const systemPrompt = [
    'You classify incoming email messages into one label from allowedTypes.',
    'Use the rule examples as semantic hints, but rely on full message meaning.',
    'Return only JSON: {"messageType":"<one allowed type>","reasoning":"<short reason>"}',
    'If uncertain, choose "other".',
  ].join(' ');

  const userPrompt = JSON.stringify({
    allowedTypes,
    fromEmail: normalizedFrom,
    toEmail: normalizedTo,
    subject: normalizedSubject,
    body: normalizedBody,
    rulesByType,
  });

  const raw = await createChatCompletion([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);

  const parsed = safeJsonParse(raw);
  const predicted = String(parsed?.messageType || '').trim().toLowerCase();
  const messageType = allowedTypes.includes(predicted) ? predicted : 'other';
  return {
    messageType,
    matchedRules: [],
    aiReasoning: String(parsed?.reasoning || '').trim(),
  };
}

/**
 * Case-insensitive: normalized subject + body + from + to are one string;
 * a rule matches if that string contains the normalized phrase (substring).
 * Rules are checked in type priority order, then creation order; first match wins.
 */
export async function classifyIncomingMessage({ subject, body, fromEmail, toEmail, rules = [] }) {
  const haystack = normalizeTextForClassification(
    `${subject || ''}\n${body || ''}\n${fromEmail || ''}\n${toEmail || ''}`
  );
  if (!haystack) {
    return { messageType: 'other', matchedRules: [] };
  }

  // Deterministic prefilter for known noisy classes (skip AI for these).
  const prefiltered = classifyByPrefilter({ subject, body, fromEmail, toEmail });
  if (prefiltered) return prefiltered;

  // Primary path: AI classification with dynamic labels from DB.
  try {
    return await classifyIncomingMessageWithAi({ subject, body, fromEmail, toEmail, rules });
  } catch (error) {
    // Fallback to deterministic rule matching if OpenAI is unavailable/errors.
    console.warn('[MessageType] AI classification failed, fallback to rule matching:', error?.message || error);
  }

  const sorted = sortRulesForClassification(rules);
  for (const rule of sorted) {
    const needle = normalizeTextForClassification(rule.pattern);
    if (needle && haystack.includes(needle)) {
      return {
        messageType: String(rule.type || 'other').toLowerCase(),
        matchedRules: [{ id: rule.id, type: rule.type, pattern: rule.pattern }],
      };
    }
  }

  return { messageType: 'other', matchedRules: [] };
}
