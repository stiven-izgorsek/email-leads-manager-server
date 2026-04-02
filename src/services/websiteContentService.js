const MAX_PAGES = 6;
const HOME_TEXT_LIMIT = 12000;
const PAGE_TEXT_LIMIT = 8000;
const COMBINED_TEXT_LIMIT = 32000;
const CONCURRENCY_LIMIT = 3;
const FETCH_TIMEOUT_MS = 8000;

const PRIORITY_PATH_CANDIDATES = [
  '/about', '/about-us', '/about-the-company', '/company', '/our-story', '/who-we-are',
  '/mission', '/vision', '/our-mission',
  '/product', '/products', '/platform', '/solution', '/solutions',
  '/features', '/technology', '/tech', '/how-it-works',
  '/customers', '/industries', '/use-cases', '/case-studies',
  '/enterprise', '/for-business',
  '/services', '/what-we-do', '/team',
];

const VALUABLE_LINK_PATTERNS = [
  /about/i, /company/i, /who we are/i, /our story/i, /mission/i,
  /product/i, /platform/i, /solution/i, /feature/i, /technology/i,
  /how it works/i, /what we do/i, /service/i, /industry/i,
  /customer/i, /use.?case/i, /case.?stud/i, /enterprise/i,
];

function normalizeUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.includes('.')) return `https://${value}`;
  return null;
}

function toAbsoluteUrl(baseUrl, href) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function normalizeTrailingSlash(url) {
  try {
    const u = new URL(url);
    return (u.origin + u.pathname).replace(/\/$/, '') + (u.search || '');
  } catch {
    return url;
  }
}

function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtmlToText(match[1]).slice(0, 200) : '';
}

function extractValuableLinks(html, baseUrl) {
  const links = new Set();
  const anchorRe = /<a[^>]+href=["']([^"'#?][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRe.exec(html)) !== null) {
    const href = match[1].trim();
    const text = match[2].replace(/<[^>]+>/g, '').trim();

    const isValuableHref = VALUABLE_LINK_PATTERNS.some((re) => re.test(href));
    const isValuableText = VALUABLE_LINK_PATTERNS.some((re) => re.test(text));
    if (!isValuableHref && !isValuableText) continue;

    const absolute = toAbsoluteUrl(baseUrl, href);
    if (!absolute) continue;

    try {
      if (new URL(absolute).hostname !== new URL(baseUrl).hostname) continue;
    } catch {
      continue;
    }

    links.add(normalizeTrailingSlash(absolute));
  }

  return [...links];
}

async function fetchHtml(url, options = {}) {
  const controller = options.signal ? null : new AbortController();
  const signal = options.signal || controller?.signal;
  const timeout = controller ? setTimeout(() => controller.abort(), 10000) : null;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EmailLeadsManagerBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal,
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;
    const html = await res.text();
    return { url: res.url || url, html };
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fetchWithConcurrency(tasks, limit) {
  const results = [];
  const queue = [...tasks];
  const active = [];

  while (queue.length > 0 || active.length > 0) {
    while (active.length < limit && queue.length > 0) {
      const task = queue.shift();
      const promise = task().then((result) => {
        active.splice(active.indexOf(promise), 1);
        results.push(result);
      });
      active.push(promise);
    }
    await Promise.race(active);
  }

  return results;
}

async function safeFetchHtml(url, timeoutMs = FETCH_TIMEOUT_MS) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const result = await fetchHtml(url, { signal: controller.signal });
    clearTimeout(timer);
    return result;
  } catch {
    return null;
  }
}

export async function fetchWebsiteContentSummary(rawUrl) {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) {
    return { sourceUrl: null, pages: [], combinedText: '' };
  }

  const visited = new Set();
  const pages = [];

  const addPage = (url, html, textLimit) => {
    visited.add(normalizeTrailingSlash(url));
    pages.push({
      url,
      title: extractTitle(html),
      text: stripHtmlToText(html).slice(0, textLimit),
    });
  };

  const home = await safeFetchHtml(normalized);
  if (home) {
    addPage(home.url, home.html, HOME_TEXT_LIMIT);
  }

  const discovered = home ? extractValuableLinks(home.html, home.url) : [];

  const fallbackCandidates = PRIORITY_PATH_CANDIDATES
    .map((path) => toAbsoluteUrl(normalized, path))
    .filter(Boolean)
    .map(normalizeTrailingSlash);

  const seenCandidates = new Set();
  const candidateQueue = [...discovered, ...fallbackCandidates].filter((url) => {
    if (!url || visited.has(url) || seenCandidates.has(url)) return false;
    seenCandidates.add(url);
    return true;
  });

  const remaining = () => MAX_PAGES - pages.length;

  const tasks = candidateQueue.slice(0, MAX_PAGES * 2).map((url) => async () => {
    if (remaining() <= 0 || visited.has(url)) return null;
    const page = await safeFetchHtml(url);
    if (!page) return null;
    const canonicalUrl = normalizeTrailingSlash(page.url);
    if (visited.has(canonicalUrl)) return null;
    return { url: page.url, canonicalUrl, html: page.html };
  });

  const fetched = await fetchWithConcurrency(tasks, CONCURRENCY_LIMIT);

  for (const result of fetched) {
    if (!result || remaining() <= 0) continue;
    if (visited.has(result.canonicalUrl)) continue;
    addPage(result.url, result.html, PAGE_TEXT_LIMIT);
  }

  const combinedText = pages
    .map(
      (page) =>
        `### PAGE: ${page.title || '(no title)'}\nURL: ${page.url}\n\n${page.text}`
    )
    .join('\n\n---\n\n')
    .slice(0, COMBINED_TEXT_LIMIT);

  return { sourceUrl: normalized, pages, combinedText };
}
