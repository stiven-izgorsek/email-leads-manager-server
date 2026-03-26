/**
 * Same behavior as contactform-fill extension background.js:
 * For each homepage URL, GET /contact on that origin; if it looks like a real page, use it; else homepage.
 * @see E:/else/email-marketing/contactform-fill/background.js
 */

const FETCH_TIMEOUT_MS = 10000;
const MIN_HTML_BYTES = 200;
const MAX_URLS = 50;
const WORKERS = 5;

function urlsEquivalent(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname.replace(/\/$/, '') === ub.pathname.replace(/\/$/, '');
  } catch {
    return false;
  }
}

function looksLikeSoft404(html) {
  const head = html.slice(0, 12000);
  const lower = head.toLowerCase();
  if (/<title[^>]*>[\s\S]*?(404|not found|page not found|page introuvable|doesn.?t exist)/i.test(head)) {
    return true;
  }
  if (lower.includes('404') && (lower.includes('not found') || lower.includes('page not found'))) {
    return true;
  }
  if (/<body[^>]*>\s*<\/body>/i.test(head)) return true;
  return false;
}

export async function resolveContactOrHome(homeUrl) {
  let home;
  try {
    home = new URL(homeUrl);
  } catch {
    return homeUrl;
  }
  if (home.protocol !== 'http:' && home.protocol !== 'https:') return homeUrl;

  const contactUrl = new URL('/contact', homeUrl).href;

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(contactUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; CRM-ContactPageProbe/1.0)',
      },
    });
    clearTimeout(tid);

    if (res.status === 404) return homeUrl;
    if (!res.ok) return homeUrl;

    const ct = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml|text\/plain/i.test(ct)) return homeUrl;

    const buf = await res.arrayBuffer();
    if (buf.byteLength < MIN_HTML_BYTES) return homeUrl;

    const peekLen = Math.min(buf.byteLength, 16384);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, peekLen));

    if (looksLikeSoft404(text)) return homeUrl;

    const finalUrl = res.url || contactUrl;
    if (urlsEquivalent(finalUrl, homeUrl)) return homeUrl;

    return finalUrl;
  } catch {
    return homeUrl;
  }
}

/**
 * @param {string[]} urls
 * @returns {Promise<string[]>}
 */
export async function resolveAllContactUrls(urls) {
  const list = Array.from(urls || [])
    .filter(Boolean)
    .slice(0, MAX_URLS);
  const results = new Array(list.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= list.length) break;
      results[i] = await resolveContactOrHome(list[i]);
    }
  }

  const n = Math.min(WORKERS, list.length) || 1;
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
