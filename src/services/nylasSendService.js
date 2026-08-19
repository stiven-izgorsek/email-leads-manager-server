import { getNylasBaseUrls } from './nylasCalendarService.js';
import { formatEmailBodyForHtmlSend } from '../utils/emailBodyHtml.js';
import { nylasFetchWithRetry } from '../utils/nylasRateLimit.js';

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

function normalizeRecipientList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    let email = '';
    let name = null;
    if (typeof item === 'string') {
      email = String(item || '').trim().toLowerCase();
    } else if (item && typeof item === 'object') {
      email = String(item.email || '').trim().toLowerCase();
      name = item.name ? String(item.name).trim() : null;
    }
    if (!email || !/^[^\s<>]+@[^\s<>]+$/.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, name: name || email });
  }
  return out;
}

export async function sendNylasEmail({
  grantId,
  nylasKey,
  toEmail,
  toName,
  toRecipients,
  ccRecipients,
  bccRecipients,
  subject,
  body,
  replyToMessageId,
}) {
  const gid = String(grantId || '').trim();
  const key = String(nylasKey || '').trim();
  const normalizedTo = normalizeRecipientList(toRecipients);
  const toList =
    normalizedTo.length > 0
      ? normalizedTo
      : toEmail
        ? normalizeRecipientList([{ email: toEmail, name: toName || toEmail }])
        : [];

  if (!gid || !key || !toList.length) {
    nylasSendLog('rejected — missing credentials', {
      hasGrant: Boolean(gid),
      hasKey: Boolean(key),
      toCount: toList.length,
    });
    return { ok: false, error: 'grantId, nylasKey, and at least one recipient are required' };
  }
  if (!subject || !body) {
    nylasSendLog('rejected — missing subject/body', { to: toList.map((r) => r.email).join(', ') });
    return { ok: false, error: 'subject and body are required' };
  }

  const cc = normalizeRecipientList(ccRecipients);
  const bcc = normalizeRecipientList(bccRecipients);
  const replyId = String(replyToMessageId || '').trim();
  const payload = {
    subject: String(subject),
    body: formatEmailBodyForHtmlSend(body),
    to: toList.map(({ email, name }) => ({ email, name: name || email })),
  };
  if (cc.length) payload.cc = cc.map(({ email, name }) => ({ email, name: name || email }));
  if (bcc.length) payload.bcc = bcc.map(({ email, name }) => ({ email, name: name || email }));
  if (replyId) {
    payload.reply_to_message_id = replyId;
  }

  const toSummary = toList.map((r) => r.email).join(', ');
  nylasSendLog('request', {
    grantPrefix: gid.slice(0, 8),
    to: toSummary,
    ccCount: cc.length,
    subject: String(subject).slice(0, 80),
    bodyLen: String(body).length,
    replyToMessageId: replyId ? `${replyId.slice(0, 12)}…` : null,
  });

  let last = { status: 0, text: '' };

  for (const baseUrl of getNylasBaseUrls()) {
    const url = `${baseUrl}/v3/grants/${encodeURIComponent(gid)}/messages/send`;
    try {
      const { response, text, attempt } = await nylasFetchWithRetry(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
        { label: 'nylas-send' }
      );
      if (response.ok) {
        let messageId = null;
        try {
          const data = JSON.parse(text);
          messageId = data?.data?.id || data?.id || null;
        } catch {
          // ignore parse
        }
        nylasSendLog('success', {
          to: toSummary,
          httpStatus: response.status,
          messageId,
          baseUrl,
          attempt,
        });
        return { ok: true, messageId, httpStatus: response.status };
      }
      last = { status: response.status, text };
      nylasSendLog('http error', {
        to: toSummary,
        baseUrl,
        httpStatus: response.status,
        attempt,
        bodyPreview: text.slice(0, 300),
      });
      if (response.status === 401 && configuredNylasRegion) break;
    } catch (err) {
      last = { status: 0, text: String(err?.message || err) };
      nylasSendLog('network error', { to: toSummary, baseUrl, error: last.text });
      if (configuredNylasRegion) break;
    }
  }

  const snippet = last.text.length > 600 ? `${last.text.slice(0, 600)}…` : last.text;
  nylasSendLog('failed all endpoints', { to: toSummary, httpStatus: last.status, error: snippet });
  return {
    ok: false,
    httpStatus: last.status || undefined,
    error: snippet || `Send failed (HTTP ${last.status || 'network'})`,
  };
}
