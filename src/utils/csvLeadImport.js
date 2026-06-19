/**
 * Shared CSV row helpers for lead import (upload API, scripts).
 * Headers are expected normalized: lowercase, no spaces (e.g. email_2).
 */

export function getCsvField(row, ...fieldNames) {
  for (const fieldName of fieldNames) {
    const key = String(fieldName).toLowerCase().replace(/\s+/g, '');
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return null;
}

/**
 * ContactOut exports: Email, Email_2, Email_3, … — use first non-empty.
 */
export function getFirstEmailFromCsvRow(row) {
  const primary = getCsvField(row, 'email', 'workemail', 'work_email', 'e-mail', 'e_mail');
  if (primary) return primary;

  for (let i = 2; i <= 30; i += 1) {
    const alt = getCsvField(row, `email_${i}`);
    if (alt) return alt;
  }

  const numberedKeys = Object.keys(row || {})
    .filter((k) => /^email_\d+$/i.test(k))
    .sort((a, b) => {
      const na = parseInt(a.replace(/^email_/i, ''), 10) || 0;
      const nb = parseInt(b.replace(/^email_/i, ''), 10) || 0;
      return na - nb;
    });

  for (const key of numberedKeys) {
    const val = getCsvField(row, key);
    if (val) return val;
  }

  return '';
}
