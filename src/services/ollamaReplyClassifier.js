/**
 * Local reply classification via Ollama (no OpenAI credits required).
 * Uses the same HTTP chat API as E:\else\ai\reply-classifier.
 */

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen2.5:3b';

function getOllamaHost() {
  return String(process.env.OLLAMA_HOST || DEFAULT_HOST).replace(/\/$/, '');
}

function getOllamaModel() {
  return String(process.env.OLLAMA_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

function getOllamaTimeoutMs() {
  const n = Number(process.env.OLLAMA_TIMEOUT_MS || 60000);
  return Number.isFinite(n) && n > 0 ? n : 60000;
}

function getOllamaKeepAlive() {
  const v = process.env.OLLAMA_KEEP_ALIVE;
  if (v == null || String(v).trim() === '') return '5m';
  return String(v).trim();
}

export function isOllamaClassifierEnabled() {
  const provider = String(process.env.REPLY_CLASSIFIER_PROVIDER || 'auto')
    .trim()
    .toLowerCase();
  if (provider === 'rules' || provider === 'openai') return false;
  if (provider === 'ollama' || provider === 'auto') return true;
  const flag = String(process.env.OLLAMA_ENABLED ?? 'true')
    .trim()
    .toLowerCase();
  return flag !== 'false' && flag !== '0' && flag !== 'no' && flag !== 'off';
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

/**
 * Quick reachability check (cached briefly so polling does not hammer Ollama).
 * @returns {Promise<boolean>}
 */
let ollamaHealthCache = { ok: null, checkedAt: 0 };

export async function isOllamaReachable() {
  const now = Date.now();
  if (ollamaHealthCache.ok != null && now - ollamaHealthCache.checkedAt < 30000) {
    return ollamaHealthCache.ok;
  }
  const host = getOllamaHost();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${host}/api/tags`, { signal: controller.signal });
    ollamaHealthCache = { ok: res.ok, checkedAt: Date.now() };
    return res.ok;
  } catch {
    ollamaHealthCache = { ok: false, checkedAt: Date.now() };
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Classify an inbound reply with a local Ollama model.
 * @param {{ subject?: string, body?: string, fromEmail?: string, toEmail?: string, allowedTypes: string[] }} params
 * @returns {Promise<{ messageType: string, aiReasoning: string, confidence: number|null, provider: 'ollama' }>}
 */
export async function classifyIncomingMessageWithOllama({
  subject,
  body,
  fromEmail,
  toEmail,
  allowedTypes = [],
}) {
  const types = (Array.isArray(allowedTypes) ? allowedTypes : [])
    .map((t) => String(t || '').trim().toLowerCase())
    .filter(Boolean);
  if (!types.length) {
    types.push('other');
  }
  if (!types.includes('other')) types.push('other');

  const host = getOllamaHost();
  const model = getOllamaModel();
  const timeoutMs = getOllamaTimeoutMs();

  const payload = {
    allowedTypes: types,
    fromEmail: trimForAi(fromEmail, 300),
    toEmail: trimForAi(toEmail, 300),
    subject: trimForAi(subject, 700),
    body: trimForAi(body, 3000),
  };

  const systemPrompt = [
    'You classify inbound email replies to cold outreach / sales emails.',
    'Pick exactly one label from allowedTypes.',
    'no_job = not hiring, not expanding the team, no vacancies. Do not use bad for that.',
    'ooo = automatic reply / auto-reply / autosvar / out of office / vacation, including non-English auto-reply subjects.',
    'bad = unsubscribe, stop emailing, or explicitly not interested in being contacted.',
    'Return only JSON: {"messageType":"<one allowed type>","confidence":0.0,"reasoning":"<short reason>"}',
    'If uncertain, choose "other".',
  ].join(' ');

  const userPrompt = [
    `Allowed types: ${types.join(', ')}`,
    '',
    'Message:',
    JSON.stringify(payload),
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        keep_alive: getOllamaKeepAlive(),
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error?.name === 'AbortError') {
      const err = new Error(`Ollama classification timed out after ${timeoutMs}ms`);
      err.code = 'OLLAMA_TIMEOUT';
      throw err;
    }
    const err = new Error(
      `Ollama unreachable at ${host}: ${error?.message || error}. Is Ollama running?`
    );
    err.code = 'OLLAMA_UNREACHABLE';
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const err = new Error(
      `Ollama error ${res.status}: ${bodyText.slice(0, 300)}. Model pulled? Try: ollama pull ${model}`
    );
    err.code = 'OLLAMA_HTTP';
    throw err;
  }

  const data = await res.json();
  const raw = data.message?.content || '';
  const parsed = safeJsonParse(raw);
  if (!parsed) {
    return {
      messageType: 'other',
      aiReasoning: 'unparseable model output',
      confidence: 0,
      provider: 'ollama',
    };
  }

  const predicted = String(parsed.messageType || parsed.type || '')
    .trim()
    .toLowerCase();
  const messageType = types.includes(predicted) ? predicted : 'other';
  const confidenceRaw = Number(parsed.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : null;

  return {
    messageType,
    aiReasoning: String(parsed.reasoning || parsed.reason || '').trim(),
    confidence,
    provider: 'ollama',
  };
}
