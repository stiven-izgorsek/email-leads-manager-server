import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORTFOLIOS_PATH = join(__dirname, '..', '..', 'assets', 'portfolios.md');

let cachedPortfolios = null;

export function getPortfolioContext() {
  if (cachedPortfolios !== null) {
    return cachedPortfolios;
  }
  if (!existsSync(PORTFOLIOS_PATH)) {
    console.warn(`applicationService: portfolios file not found at ${PORTFOLIOS_PATH}`);
    cachedPortfolios = '';
    return cachedPortfolios;
  }
  cachedPortfolios = readFileSync(PORTFOLIOS_PATH, 'utf8');
  return cachedPortfolios;
}

function normalizeForMatch(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
}

function tokenize(text) {
  return normalizeForMatch(text)
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

export function getRelevantPortfolioContext(query, options = {}) {
  const { maxSections = 4, maxChars = 7000 } = options;
  const source = getPortfolioContext();
  if (!source) return '';

  const sections = source
    .split(/={8,}/)
    .map((section) => section.trim())
    .filter(Boolean);

  if (!sections.length) {
    return source.slice(0, maxChars);
  }

  const tokens = tokenize(query);
  const scored = sections
    .map((section, index) => {
      const haystack = normalizeForMatch(section);
      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) score += 1;
      }
      if (index === 0) score += 0.5;
      return { section, score };
    })
    .sort((a, b) => b.score - a.score);

  const picked = scored
    .filter((item, index) => item.score > 0 || index === 0)
    .slice(0, maxSections)
    .map((item) => item.section);

  const result = picked.join('\n\n=====================================================\n\n');
  return result.length > maxChars ? result.slice(0, maxChars) : result;
}

function getOpenAiKey() {
  return process.env.OPEN_AI_API_KEY || process.env.OPENAI_API_KEY || '';
}

function getOpenAiModel() {
  return process.env.OPEN_AI_MODEL || 'gpt-4o-mini';
}

export function assertOpenAiConfigured() {
  const key = getOpenAiKey();
  if (!key) {
    const err = new Error('OpenAI API key is not configured. Set OPEN_AI_API_KEY or OPENAI_API_KEY in the environment.');
    err.status = 503;
    throw err;
  }
}

/**
 * @param {Array<{ role: 'system' | 'user' | 'assistant'; content: string }>} messages
 * @returns {Promise<string>}
 */
export async function createChatCompletion(messages) {
  assertOpenAiConfigured();
  const key = getOpenAiKey();
  const model = getOpenAiModel();
  const controller = new AbortController();
  const timeoutMs = Number(process.env.OPEN_AI_TIMEOUT_MS || 25000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error?.name === 'AbortError') {
      const err = new Error('OpenAI request timed out. Please try a shorter question or try again.');
      err.status = 504;
      throw err;
    }
    throw error;
  }
  clearTimeout(timeout);

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data?.error?.message || res.statusText || 'OpenAI request failed';
    const err = new Error(msg);
    err.status = res.status >= 400 && res.status < 500 ? 400 : 502;
    throw err;
  }

  const text = data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string') {
    const err = new Error('Unexpected response from OpenAI');
    err.status = 502;
    throw err;
  }

  return text.trim();
}
