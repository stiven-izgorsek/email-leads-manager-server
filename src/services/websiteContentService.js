const ABOUT_PATH_CANDIDATES = [
  '/',
  '/about',
  '/about-us',
  '/who-we-are',
  '/company',
  '/our-story',
  '/team',
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

function extractAboutLinks(html, baseUrl) {
  const hrefMatches = Array.from(String(html || '').matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi));
  const discovered = new Set();

  for (const match of hrefMatches) {
    const href = match[1];
    const anchorText = stripHtmlToText(match[2]).toLowerCase();
    const hrefLower = String(href || '').toLowerCase();
    const looksRelevant =
      /about|who-we-are|our-story|company|team/.test(hrefLower) ||
      /about|who we are|our story|company|team/.test(anchorText);

    if (!looksRelevant) continue;
    const abs = toAbsoluteUrl(baseUrl, href);
    if (abs) discovered.add(abs);
  }

  return Array.from(discovered).slice(0, 4);
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EmailLeadsManagerBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;
    const html = await res.text();
    return { url: res.url || url, html };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchWebsiteContentSummary(rawUrl) {
  const normalized = normalizeUrl(rawUrl);
  if (!normalized) {
    return {
      sourceUrl: null,
      pages: [],
      combinedText: '',
    };
  }

  const visited = new Set();
  const pages = [];

  const home = await fetchHtml(normalized);
  if (home) {
    visited.add(home.url);
    const title = extractTitle(home.html);
    const text = stripHtmlToText(home.html).slice(0, 12000);
    pages.push({ url: home.url, title, text });

    const discoveredAboutLinks = extractAboutLinks(home.html, home.url);
    for (const link of discoveredAboutLinks) {
      if (visited.has(link)) continue;
      const page = await fetchHtml(link);
      if (!page) continue;
      visited.add(page.url);
      pages.push({
        url: page.url,
        title: extractTitle(page.html),
        text: stripHtmlToText(page.html).slice(0, 8000),
      });
      if (pages.length >= 4) break;
    }
  }

  if (pages.length < 2) {
    for (const path of ABOUT_PATH_CANDIDATES) {
      const candidate = toAbsoluteUrl(normalized, path);
      if (!candidate || visited.has(candidate)) continue;
      const page = await fetchHtml(candidate);
      if (!page) continue;
      visited.add(page.url);
      pages.push({
        url: page.url,
        title: extractTitle(page.html),
        text: stripHtmlToText(page.html).slice(0, 8000),
      });
      if (pages.length >= 4) break;
    }
  }

  const combinedText = pages
    .map((page) => `URL: ${page.url}\nTITLE: ${page.title}\nCONTENT:\n${page.text}`)
    .join('\n\n---\n\n')
    .slice(0, 24000);

  return {
    sourceUrl: normalized,
    pages,
    combinedText,
  };
}
