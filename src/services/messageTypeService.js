import { AppDataSource } from '../config/database.js';
import { MessageTypeRule } from '../entities/MessageTypeRule.js';

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
  { type: 'interest', pattern: 'linkedin profile' },
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

/**
 * Case-insensitive: normalized subject + body + from + to are one string;
 * a rule matches if that string contains the normalized phrase (substring).
 * Rules are checked in type priority order, then creation order; first match wins.
 */
export function classifyIncomingMessage({ subject, body, fromEmail, toEmail, rules = [] }) {
  const haystack = normalizeTextForClassification(
    `${subject || ''}\n${body || ''}\n${fromEmail || ''}\n${toEmail || ''}`
  );
  if (!haystack) {
    return { messageType: 'other', matchedRules: [] };
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
