import { getNylasBaseUrls } from './nylasCalendarService.js';
import { formatEmailBodyForHtmlSend } from '../utils/emailBodyHtml.js';

const configuredNylasRegion = (process.env.NYLAS_REGION || '').toLowerCase();

/**
 * Send an email via Nylas v3 (requires gmail.send or equivalent on the grant).
 * @returns {{ ok: boolean, messageId?: string, httpStatus?: number, error?: string }}
 */
function nylasSendLog(message, extra) {
  const suffix =
    extra && typeof extra === 'object' && Object.keys(extra).length > 0
      ? ` ${JSON.stringify(extra)}`
      : '';
  console.log(`[nylas-send] ${new Date().toISOString()} ${message}${suffix}`);
}

export async function sendNylasEmail({
  grantId,
  nylasKey,
  toEmail,
  toName,
  subject,
  body,
  replyToMessageId,
}) {
  const gid = String(grantId || '').trim();
  const key = String(nylasKey || '').trim();
  const to = String(toEmail || '').trim().toLowerCase();

  if (!gid || !key || !to) {
    nylasSendLog('rejected — missing credentials', {
      hasGrant: Boolean(gid),
      hasKey: Boolean(key),
      hasTo: Boolean(to),
    });
    return { ok: false, error: 'grantId, nylasKey, and toEmail are required' };
  }
  if (!subject || !body) {
    nylasSendLog('rejected — missing subject/body', { to });
    return { ok: false, error: 'subject and body are required' };
  }

  const replyId = String(replyToMessageId || '').trim();
  const payload = {
    subject: String(subject),
    body: formatEmailBodyForHtmlSend(body),
    to: [{ email: to, name: toName ? String(toName) : to }],
  };
  if (replyId) {
    payload.reply_to_message_id = replyId;
  }

  nylasSendLog('request', {
    grantPrefix: gid.slice(0, 8),
    to,
    subject: String(subject).slice(0, 80),
    bodyLen: String(body).length,
    replyToMessageId: replyId ? `${replyId.slice(0, 12)}…` : null,
  });

  let last = { status: 0, text: '' };

  for (const baseUrl of getNylasBaseUrls()) {
    const url = `${baseUrl}/v3/grants/${encodeURIComponent(gid)}/messages/send`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const text = await response.text().catch(() => '');
      if (response.ok) {
        let messageId = null;
        try {
          const data = JSON.parse(text);
          messageId = data?.data?.id || data?.id || null;
        } catch {
          // ignore parse
        }
        nylasSendLog('success', { to, httpStatus: response.status, messageId, baseUrl });
        return { ok: true, messageId, httpStatus: response.status };
      }
      last = { status: response.status, text };
      nylasSendLog('http error', {
        to,
        baseUrl,
        httpStatus: response.status,
        bodyPreview: text.slice(0, 300),
      });
      if (response.status === 401 && configuredNylasRegion) break;
    } catch (err) {
      last = { status: 0, text: String(err?.message || err) };
      nylasSendLog('network error', { to, baseUrl, error: last.text });
      if (configuredNylasRegion) break;
    }
  }

  const snippet = last.text.length > 600 ? `${last.text.slice(0, 600)}…` : last.text;
  nylasSendLog('failed all endpoints', { to, httpStatus: last.status, error: snippet });
  return {
    ok: false,
    httpStatus: last.status || undefined,
    error: snippet || `Send failed (HTTP ${last.status || 'network'})`,
  };
}
