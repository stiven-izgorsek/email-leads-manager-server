/**
 * CSV helpers for lead/company exports.
 */

export function csvEscape(val) {
  if (val === null || val === undefined) return '';
  let s;
  if (val instanceof Date) {
    s = Number.isNaN(val.getTime()) ? '' : val.toISOString();
  } else if (Array.isArray(val)) {
    s = val.map((x) => String(x ?? '').trim()).filter(Boolean).join('; ');
  } else {
    s = String(val)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n/g, ' ');
  }
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'hotmail.com',
  'hotmail.co.uk',
  'outlook.com',
  'live.com',
  'icloud.com',
  'me.com',
  'protonmail.com',
  'proton.me',
  'aol.com',
  'mail.com',
  'gmx.com',
  'gmx.de',
  'web.de',
  'msn.com',
  'ymail.com',
]);

/** Normalize company website URL for CSV export (matches upload/import behavior). */
export function normalizeCompanyUrlForExport(raw) {
  let url = String(raw ?? '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url) && url.includes('.')) {
    url = `https://${url}`;
  }
  return url;
}

/** When companyUrl is missing, infer from corporate email domain (e.g. user@acme.com → https://acme.com). */
export function companyUrlFromEmail(email) {
  const em = String(email || '').trim().toLowerCase();
  const at = em.lastIndexOf('@');
  if (at <= 0) return '';
  const domain = em.slice(at + 1);
  if (!domain || !domain.includes('.') || FREE_EMAIL_DOMAINS.has(domain)) return '';
  return normalizeCompanyUrlForExport(domain);
}

export function resolveLeadCompanyUrl(lead) {
  const stored = normalizeCompanyUrlForExport(lead?.companyUrl);
  if (stored) return stored;
  return companyUrlFromEmail(lead?.email);
}

/** Column definitions for new-leads CSV (header + value getter). */
export const LEAD_CSV_EXPORT_COLUMNS = [
  { header: 'id', get: (l) => l.id },
  { header: 'email', get: (l) => l.email },
  { header: 'firstName', get: (l) => l.firstName },
  { header: 'lastName', get: (l) => l.lastName },
  { header: 'companyName', get: (l) => l.companyName },
  { header: 'jobTitle', get: (l) => l.jobTitle },
  { header: 'status', get: (l) => l.status },
  { header: 'location', get: (l) => l.location },
  { header: 'companyLocation', get: (l) => l.companyLocation },
  { header: 'linkedin', get: (l) => l.linkedin },
  { header: 'website', get: (l) => resolveLeadCompanyUrl(l) },
  { header: 'companyUrl', get: (l) => resolveLeadCompanyUrl(l) },
  { header: 'industries', get: (l) => l.industries },
  { header: 'tech', get: (l) => l.tech },
  { header: 'employees', get: (l) => l.employees },
  { header: 'contactedBy', get: (l) => l.contactedBy },
  { header: 'millionsStatus', get: (l) => l.millionsStatus },
  { header: 'isSent', get: (l) => l.isSent },
  { header: 'isReplied', get: (l) => l.isReplied },
  { header: 'isFollowup', get: (l) => l.isFollowup },
  { header: 'lastSent', get: (l) => l.lastSent },
  { header: 'createdAt', get: (l) => l.createdAt },
  { header: 'updatedAt', get: (l) => l.updatedAt },
  { header: 'note', get: (l) => l.note },
];

export function leadToCsvLine(lead, columns = LEAD_CSV_EXPORT_COLUMNS) {
  return columns.map((col) => csvEscape(col.get(lead))).join(',');
}

export function leadsToCsv(leads, columns = LEAD_CSV_EXPORT_COLUMNS) {
  const lines = [columns.map((c) => c.header).join(',')];
  for (const lead of leads) {
    lines.push(leadToCsvLine(lead, columns));
  }
  return lines.join('\r\n');
}
