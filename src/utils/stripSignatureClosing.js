/**
 * Remove a trailing email closing ("Best,", "Best regards,", etc.) and the
 * following name / {{senderName}} line. Used when the mailbox already has a
 * Gmail signature configured.
 */
const CLOSING_PHRASE =
  '(?:Best\\s+regards|Kind\\s+regards|Warm\\s+regards|Best|Sincerely|Thanks(?:\\s+and\\s+regards)?|Thank\\s+you|Cheers)\\s*,?';

const PLAIN_TRAILING_CLOSING_RE = new RegExp(
  `(?:\\r?\\n|\\r|\\s)*${CLOSING_PHRASE}(?:\\r?\\n|\\r|\\s)+(?:\\{\\{senderName\\}\\}|[^\\n\\r<]{1,80})\\s*$`,
  'i'
);

const HTML_TRAILING_CLOSING_RE = new RegExp(
  `(?:(?:<br\\s*\\/?>)|(?:<\\/p\\s*>)|(?:\\s))*${CLOSING_PHRASE}(?:(?:<br\\s*\\/?>)|(?:<\\/p\\s*>)|(?:\\s|<p[^>]*>))+` +
    `(?:\\{\\{senderName\\}\\}|[^<\\n\\r]{1,80})(?:\\s*)(?:(?:<br\\s*\\/?>)|(?:<\\/p\\s*>))?\\s*$`,
  'i'
);

export function parseIsSignatureAdded(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return defaultValue;
}

export function stripTrailingSignatureClosing(body, isSignatureAdded = false) {
  if (!isSignatureAdded || body == null) return body;
  let result = String(body);
  const before = result;
  result = result.replace(HTML_TRAILING_CLOSING_RE, '');
  if (result === before) {
    result = result.replace(PLAIN_TRAILING_CLOSING_RE, '');
  }
  return result.replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
}
