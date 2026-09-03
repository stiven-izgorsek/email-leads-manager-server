import { AppDataSource } from '../config/database.js';
import { MessageTypeRule } from '../entities/MessageTypeRule.js';
import { refreshClientLastInboundMessageType } from './leadReplyStatusService.js';
import { createChatCompletion } from './applicationService.js';
import {
  classifyIncomingMessageWithOllama,
  isOllamaClassifierEnabled,
  isOllamaReachable,
} from './ollamaReplyClassifier.js';

/** Default order when several types could match: earlier types win over later ones. */
const TYPE_ORDER = [
  'no_address',
  'blocked',
  'delivery_failed',
  'ooo',
  'no_job',
  'bad',
  'interest',
  'other',
];

export const DEFAULT_MESSAGE_TYPE_RULES = [
  { type: 'no_address', pattern: 'address not found' },
  { type: 'no_address', pattern: 'address couldn\'t be found' },
  { type: 'no_address', pattern: 'address could not be found' },
  { type: 'no_address', pattern: 'unable to receive mail' },

  { type: 'blocked', pattern: 'message blocked' },

  { type: 'delivery_failed', pattern: 'delivery incomplete' },
  { type: 'delivery_failed', pattern: 'delivery status notification' },
  { type: 'delivery_failed', pattern: 'mail delivery subsystem' },
  { type: 'delivery_failed', pattern: 'message not delivered' },
  { type: 'delivery_failed', pattern: 'delivery has failed' },
  { type: 'delivery_failed', pattern: 'returned mail' },
  { type: 'delivery_failed', pattern: 'temporary problem while delivering' },

  { type: 'ooo', pattern: 'out of office' },
  { type: 'ooo', pattern: 'i am not in office' },
  { type: 'ooo', pattern: 'i am on vacation' },
  { type: 'ooo', pattern: 'on leave' },
  { type: 'ooo', pattern: 'on holiday' },
  { type: 'ooo', pattern: 'automatic reply' },
  { type: 'ooo', pattern: 'auto-reply' },
  { type: 'ooo', pattern: 'autoreply' },
  { type: 'ooo', pattern: 'autosavr' },
  { type: 'ooo', pattern: 'autosvar' },
  { type: 'ooo', pattern: 'auto svar' },
  { type: 'ooo', pattern: 'automatische antwort' },
  { type: 'ooo', pattern: 'automatisch antwoord' },
  { type: 'ooo', pattern: 'réponse automatique' },
  { type: 'ooo', pattern: 'reponse automatique' },
  { type: 'ooo', pattern: 'respuesta automática' },
  { type: 'ooo', pattern: 'resposta automática' },
  { type: 'ooo', pattern: 'risposta automatica' },
  { type: 'ooo', pattern: 'automatisk svar' },
  { type: 'ooo', pattern: 'abwesenheit' },
  { type: 'ooo', pattern: 'afwezig' },
  { type: 'ooo', pattern: 'hors du bureau' },
  { type: 'ooo', pattern: 'automated response' },
  { type: 'ooo', pattern: 'auto response' },
  { type: 'ooo', pattern: 'automaattinen vastaus' },
  { type: 'ooo', pattern: 'automaatvastus' },
  { type: 'ooo', pattern: 'on vacation' },
  { type: 'ooo', pattern: 'congés' },

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
  { type: 'no_job', pattern: 'not expanding our team' },
  { type: 'no_job', pattern: 'not expanding' },
  { type: 'no_job', pattern: 'not currently hiring' },
  { type: 'no_job', pattern: 'not looking to hire' },
  { type: 'no_job', pattern: 'not recruiting' },
  { type: 'no_job', pattern: 'no headcount' },

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
  const unique = new Set(TYPE_ORDER);
  for (const r of Array.isArray(rules) ? rules : []) {
    const type = String(r?.type || '').trim().toLowerCase();
    if (type) unique.add(type);
  }
  unique.add('other');
  return Array.from(unique);
}

function getReplyClassifierProvider() {
  return String(process.env.REPLY_CLASSIFIER_PROVIDER || 'auto')
    .trim()
    .toLowerCase();
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

const NO_ADDRESS_PATTERNS = [
  /\baddress\s+not\s+found\b/i,
  /\baddress\s+couldn'?t\s+be\s+found\b/i,
  /\baddress\s+could\s+not\s+be\s+found\b/i,
  /\bunable\s+to\s+receive\s+mail\b/i,
  /\buser\s+unknown\b/i,
  /\bmailbox\s+(?:not\s+found|unavailable|does\s+not\s+exist)\b/i,
];

const DOMAIN_BLOCK_PATTERNS = [
  /\bmessage\s+blocked\b/i,
  /policy that prohibited/i,
  /support\.google\.com\/a\/answer\/172179/i,
];

const DELIVERY_FAILED_PATTERNS = [
  /\bdelivery\s+incomplete\b/i,
  /\bdelivery\s+status\s+notification\b/i,
  /\bmail\s+delivery\s+subsystem\b/i,
  /\bmessage\s+not\s+delivered\b/i,
  /\bdelivery\s+has\s+failed\b/i,
  /\breturned\s+mail\b/i,
  /\bundeliverable\b/i,
  /\bmailer-daemon\b/i,
  /\btemporary\s+problem\s+while\s+delivering\b/i,
  /\byour\s+message\s+wasn'?t\s+delivered\b/i,
  /\brecipient\s+server\s+did\s+not\s+accept\b/i,
  /\bgmail\s+will\s+retry\b/i,
];

const OOO_SUBJECT_PATTERNS = [
  /\bautomatic\s+reply\b/i,
  /\bauto-?reply\b/i,
  /\bauto\s+reply\b/i,
  /\bautosavr\b/i,
  /\bautosvar\b/i,
  /\bauto\s+svar\b/i,
  /\bautomatische\s+antwort\b/i,
  /\bautomatisch\s+antwoord\b/i,
  /\br[ée]ponse\s+automatique\b/i,
  /\brespuesta\s+autom[aá]tica\b/i,
  /\bresposta\s+autom[aá]tica\b/i,
  /\brisposta\s+automatica\b/i,
  /\bautomatisk\s+svar\b/i,
  /\bout\s+of\s+office\b/i,
  /\babwesen/i,
  /\bafwezig\b/i,
  /\bhors\s+du\s+bureau\b/i,
  /\bfuera\s+de\s+oficina\b/i,
  /\babsence\s+du\s+bureau\b/i,
  /\bnicht\s+im\s+b[uü]ro\b/i,
  /\bautomated\s+response\b/i,
  /\bauto\s+response\b/i,
  /\bautomaattinen\s+vastaus\b/i,
  /\bautomaatvastus\b/i,
  /\bon\s+vacation\b/i,
  /\bcong[eé]s\b/i,
  /\bautomatyczna\s+odpowied/i,
  /\bautomatick[aá]\s+odpov/i,
  /\bautomatikus\s+v[aá]lasz\b/i,
];

const NO_JOB_PATTERNS = [
  /\bnot\s+hiring\b/i,
  /\bhiring\s+freeze\b/i,
  /\bno\s+(?:vacancies|openings|opportunities|roles|headcount)\b/i,
  /\bnot\s+expanding(?:\s+our)?\s+team\b/i,
  /\bnot\s+expan\w*/i,
  /\bnot\s+currently\s+hiring\b/i,
  /\bnot\s+looking\s+to\s+hire\b/i,
  /\bnot\s+recruiting\b/i,
  /\bno\s+plans?\s+to\s+(?:hire|expand|recruit)\b/i,
  /\bwe\s+are\s+not\s+hiring\b/i,
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
  if (NO_ADDRESS_PATTERNS.some((rx) => rx.test(text))) {
    return {
      messageType: 'no_address',
      matchedRules: [],
      prefiltered: 'no_address',
    };
  }
  if (DOMAIN_BLOCK_PATTERNS.some((rx) => rx.test(text))) {
    return {
      messageType: 'blocked',
      matchedRules: [],
      prefiltered: 'domain_block',
    };
  }
  if (DELIVERY_FAILED_PATTERNS.some((rx) => rx.test(text))) {
    return {
      messageType: 'delivery_failed',
      matchedRules: [],
      prefiltered: 'delivery_failed',
    };
  }
  const subjectText = String(subject || '');
  const looksOoo =
    /^auto\s*:/i.test(subjectText) ||
    /\booo\b/i.test(subjectText) ||
    OOO_SUBJECT_PATTERNS.some((rx) => rx.test(subjectText) || rx.test(text));
  if (looksOoo) {
    return {
      messageType: 'ooo',
      matchedRules: [],
      prefiltered: 'ooo',
    };
  }
  if (NO_JOB_PATTERNS.some((rx) => rx.test(text))) {
    return {
      messageType: 'no_job',
      matchedRules: [],
      prefiltered: 'no_job',
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
  const existing = await repo.find();
  if (existing.length === 0) {
    for (const rule of DEFAULT_MESSAGE_TYPE_RULES) {
      await repo.save(repo.create(rule));
    }
  } else {
    const byPattern = new Map(
      existing.map((row) => [String(row.pattern || '').trim().toLowerCase(), row])
    );
    for (const rule of DEFAULT_MESSAGE_TYPE_RULES) {
      const key = String(rule.pattern || '').trim().toLowerCase();
      const match = byPattern.get(key);
      if (!match) {
        const saved = await repo.save(repo.create(rule));
        byPattern.set(key, saved);
        continue;
      }
      if (String(match.type || '').toLowerCase() !== rule.type) {
        match.type = rule.type;
        await repo.save(match);
      }
    }
  }
  await reclassifyStoredDeliveryMessages();
  seededDefaults = true;
}

async function reclassifyStoredDeliveryMessages() {
  await AppDataSource.manager.query(`
    UPDATE incoming_message
    SET "messageType" = 'no_address'
    WHERE "deletedAt" IS NULL
      AND "messageType" = 'blocked'
      AND (
        LOWER(COALESCE(subject, '')) LIKE '%address not found%'
        OR LOWER(COALESCE(body_text, '')) LIKE '%address not found%'
        OR LOWER(COALESCE(body_html, '')) LIKE '%address not found%'
        OR LOWER(COALESCE(body_text, '')) LIKE '%unable to receive mail%'
        OR LOWER(COALESCE(subject, '')) LIKE '%unable to receive mail%'
      )
  `);

  await AppDataSource.manager.query(`
    UPDATE incoming_message
    SET "messageType" = 'delivery_failed'
    WHERE "deletedAt" IS NULL
      AND "messageType" = 'blocked'
      AND (
        LOWER(COALESCE(subject, '')) LIKE '%delivery status notification%'
        OR LOWER(COALESCE(subject, '')) LIKE '%delivery incomplete%'
        OR LOWER(COALESCE(subject, '')) LIKE '%message not delivered%'
        OR LOWER(COALESCE(subject, '')) LIKE '%delivery has failed%'
        OR LOWER(COALESCE("fromEmail", '')) LIKE '%mailer-daemon%'
        OR LOWER(COALESCE("fromEmail", '')) LIKE '%mail delivery%'
        OR LOWER(COALESCE(body_text, '')) LIKE '%delivery incomplete%'
        OR LOWER(COALESCE(body_html, '')) LIKE '%delivery incomplete%'
      )
  `);

  await AppDataSource.manager.query(`
    UPDATE incoming_message
    SET "messageType" = 'no_job'
    WHERE "deletedAt" IS NULL
      AND "messageType" = 'bad'
      AND (
        LOWER(COALESCE(subject, '') || ' ' || COALESCE(body_text, '') || ' ' || COALESCE(body_html, ''))
          LIKE '%not expan%'
        OR LOWER(COALESCE(subject, '') || ' ' || COALESCE(body_text, '') || ' ' || COALESCE(body_html, ''))
          LIKE '%not hiring%'
        OR LOWER(COALESCE(subject, '') || ' ' || COALESCE(body_text, '') || ' ' || COALESCE(body_html, ''))
          LIKE '%hiring freeze%'
        OR LOWER(COALESCE(subject, '') || ' ' || COALESCE(body_text, '') || ' ' || COALESCE(body_html, ''))
          LIKE '%no vacancies%'
        OR LOWER(COALESCE(subject, '') || ' ' || COALESCE(body_text, '') || ' ' || COALESCE(body_html, ''))
          LIKE '%no openings%'
        OR LOWER(COALESCE(subject, '') || ' ' || COALESCE(body_text, '') || ' ' || COALESCE(body_html, ''))
          LIKE '%not recruiting%'
      )
  `);

  await AppDataSource.manager.query(`
    UPDATE incoming_message
    SET "messageType" = 'ooo'
    WHERE "deletedAt" IS NULL
      AND subject IS NOT NULL
      AND "messageType" NOT IN ('ooo', 'hide_sender', 'ignored_sender')
      AND (
        subject ILIKE '%automatic reply%'
        OR subject ILIKE '%auto-reply%'
        OR subject ILIKE '%autoreply%'
        OR subject ILIKE '%auto reply%'
        OR subject ILIKE '%autosavr%'
        OR subject ILIKE '%autosvar%'
        OR subject ILIKE '%auto svar%'
        OR subject ILIKE '%automatische antwort%'
        OR subject ILIKE '%automatisch antwoord%'
        OR subject ILIKE '%réponse automatique%'
        OR subject ILIKE '%reponse automatique%'
        OR subject ILIKE '%respuesta automática%'
        OR subject ILIKE '%respuesta automatica%'
        OR subject ILIKE '%resposta automática%'
        OR subject ILIKE '%resposta automatica%'
        OR subject ILIKE '%risposta automatica%'
        OR subject ILIKE '%automatisk svar%'
        OR subject ILIKE '%out of office%'
        OR subject ILIKE '%abwesen%'
        OR subject ILIKE '%afwezig%'
        OR subject ILIKE '%hors du bureau%'
        OR subject ILIKE '%fuera de oficina%'
        OR subject ILIKE '%absence du bureau%'
        OR subject ILIKE '%nicht im büro%'
        OR subject ILIKE '%nicht im buero%'
        OR subject ILIKE '%automated response%'
        OR subject ILIKE '%auto response%'
        OR subject ILIKE '%automaattinen vastaus%'
        OR subject ILIKE '%automaatvastus%'
        OR subject ILIKE '%on vacation%'
        OR subject ILIKE '%congés%'
        OR subject ILIKE '%conges%'
        OR subject ILIKE 'Auto:%'
        OR subject ~* '(^|[^a-z])ooo([^a-z]|$)'
      )
  `);

  try {
    await refreshClientLastInboundMessageType();
  } catch (err) {
    console.error('[message-type] Failed refreshing last_inbound_message_type after reclassify:', err.message || err);
  }
}

export async function loadMessageTypeRules() {
  const repo = AppDataSource.getRepository(MessageTypeRule);
  return repo.find({
    order: { createdAt: 'ASC' },
  });
}

async function classifyIncomingMessageWithOpenAi({ subject, body, fromEmail, toEmail, rules = [] }) {
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
    'no_job = they are not hiring / not expanding the team / no vacancies. That is not "bad".',
    'ooo = automatic reply / auto-reply / autosvar / out of office / vacation, including non-English subjects such as Automatische Antwort or Réponse automatique.',
    'bad = unsubscribe, stop contacting, or explicitly not interested in further emails.',
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
    provider: 'openai',
  };
}

function classifyByRules({ subject, body, fromEmail, toEmail, rules = [] }) {
  const haystack = normalizeTextForClassification(
    `${subject || ''}\n${body || ''}\n${fromEmail || ''}\n${toEmail || ''}`
  );
  if (!haystack) {
    return { messageType: 'other', matchedRules: [], provider: 'rules' };
  }

  const sorted = sortRulesForClassification(rules);
  for (const rule of sorted) {
    const needle = normalizeTextForClassification(rule.pattern);
    if (needle && haystack.includes(needle)) {
      return {
        messageType: String(rule.type || 'other').toLowerCase(),
        matchedRules: [{ id: rule.id, type: rule.type, pattern: rule.pattern }],
        provider: 'rules',
      };
    }
  }

  return { messageType: 'other', matchedRules: [], provider: 'rules' };
}

/**
 * Path: prefilter → Ollama (local) → OpenAI → keyword rules
 * (order depends on REPLY_CLASSIFIER_PROVIDER: auto | ollama | openai | rules).
 */
export async function classifyIncomingMessage({ subject, body, fromEmail, toEmail, rules = [] }) {
  const haystack = normalizeTextForClassification(
    `${subject || ''}\n${body || ''}\n${fromEmail || ''}\n${toEmail || ''}`
  );
  if (!haystack) {
    return { messageType: 'other', matchedRules: [] };
  }

  const prefiltered = classifyByPrefilter({ subject, body, fromEmail, toEmail });
  if (prefiltered) return prefiltered;

  const provider = getReplyClassifierProvider();
  const allowedTypes = getAllowedTypesFromRules(rules);
  const args = { subject, body, fromEmail, toEmail, rules };

  const tryOllama = async () => {
    if (!isOllamaClassifierEnabled()) return null;
    if (!(await isOllamaReachable())) {
      console.warn('[MessageType] Ollama not reachable; skipping local classifier');
      return null;
    }
    const result = await classifyIncomingMessageWithOllama({
      subject,
      body,
      fromEmail,
      toEmail,
      allowedTypes,
    });
    return {
      messageType: result.messageType,
      matchedRules: [],
      aiReasoning: result.aiReasoning,
      confidence: result.confidence,
      provider: 'ollama',
    };
  };

  if (provider === 'rules') {
    return classifyByRules(args);
  }

  if (provider === 'ollama') {
    try {
      const local = await tryOllama();
      if (local) return local;
    } catch (error) {
      console.warn('[MessageType] Ollama classification failed:', error?.message || error);
    }
    return classifyByRules(args);
  }

  if (provider === 'openai') {
    try {
      return await classifyIncomingMessageWithOpenAi(args);
    } catch (error) {
      console.warn(
        '[MessageType] OpenAI classification failed, fallback to rules:',
        error?.message || error
      );
    }
    return classifyByRules(args);
  }

  // auto (default): ollama → openai → rules
  try {
    const local = await tryOllama();
    if (local) return local;
  } catch (error) {
    console.warn(
      '[MessageType] Ollama classification failed, trying OpenAI:',
      error?.message || error
    );
  }

  try {
    return await classifyIncomingMessageWithOpenAi(args);
  } catch (error) {
    console.warn(
      '[MessageType] OpenAI classification failed, fallback to rules:',
      error?.message || error
    );
  }

  return classifyByRules(args);
}
