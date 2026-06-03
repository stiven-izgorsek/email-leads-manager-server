/**
 * Nylas v3 send expects an HTML body. Plain text with newlines is collapsed in Gmail.
 * Mirrors gmail-extension content.js: template.replace(/\n/g, "<br>").
 */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function looksLikeHtml(body) {
  return /<\s*(br|p|div|span|table|ul|ol|li|html|body|h[1-6])\b/i.test(body);
}

/**
 * @param {string} body Plain text or HTML email body
 * @returns {string} HTML suitable for Nylas `body`
 */
export function formatEmailBodyForHtmlSend(body) {
  const raw = String(body ?? '');
  if (!raw.trim()) return '';

  if (looksLikeHtml(raw)) {
    return raw;
  }

  const normalized = raw.replace(/\r\n/g, '\n');
  const escaped = escapeHtml(normalized);
  const paragraphs = escaped.split(/\n\n+/);

  if (paragraphs.length > 1) {
    return paragraphs
      .map((p) => `<p style="margin:0 0 1em 0;line-height:1.5;">${p.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;">${escaped.replace(/\n/g, '<br>')}</div>`;
}
