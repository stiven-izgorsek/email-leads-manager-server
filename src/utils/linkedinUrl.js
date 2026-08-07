/**
 * Normalize LinkedIn profile URLs for dedupe / enrichment matching.
 * Returns null if the value is empty or not a usable profile URL.
 */
export function normalizeLinkedInUrl(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;

  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (!host.includes('linkedin.com')) {
      return s.replace(/\/+$/, '').toLowerCase();
    }
    let path = u.pathname.replace(/\/+$/, '').toLowerCase();
    // Prefer canonical /in/{slug} form when present
    const inMatch = path.match(/\/in\/([^/]+)/);
    if (inMatch) {
      return `https://www.linkedin.com/in/${inMatch[1]}`;
    }
    return `https://www.linkedin.com${path}`;
  } catch {
    return s.replace(/\/+$/, '').toLowerCase();
  }
}

export function extractLinkedInSlug(raw) {
  const normalized = normalizeLinkedInUrl(raw);
  if (!normalized) return null;
  const m = normalized.match(/\/in\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Normalize LinkedIn *company* page URLs for same-company lead filtering.
 * Returns null if empty or not a usable /company/{slug} URL.
 */
export function normalizeCompanyLinkedInUrl(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;

  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (!host.includes('linkedin.com')) return null;
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    const companyMatch = path.match(/\/company\/([^/]+)/);
    if (!companyMatch) return null;
    return `https://www.linkedin.com/company/${companyMatch[1]}`;
  } catch {
    return null;
  }
}

export function isApolloTool(tool) {
  return String(tool || '').trim().toLowerCase() === 'apollo';
}
