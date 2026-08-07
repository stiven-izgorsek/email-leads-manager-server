import nodemailer from 'nodemailer';
import { formatEmailBodyForHtmlSend } from '../utils/emailBodyHtml.js';

function smtpSendLog(message, extra) {
  const suffix =
    extra && typeof extra === 'object' && Object.keys(extra).length > 0
      ? ` ${JSON.stringify(extra)}`
      : '';
  console.log(`[smtp-send] ${new Date().toISOString()} ${message}${suffix}`);
}

const SMTP_ENDPOINTS = [
  // Prefer submission port — less often blocked than SMTPS 465.
  { host: 'smtp.gmail.com', port: 587, secure: false, requireTLS: true },
  { host: 'smtp.gmail.com', port: 465, secure: true },
];

function createGmailTransporter(user, pass, endpoint) {
  return nodemailer.createTransport({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    requireTLS: endpoint.requireTLS || false,
    auth: { user, pass },
    // Force IPv4 — avoids ENETUNREACH on broken IPv6 routes.
    family: 4,
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 45_000,
  });
}

/**
 * Send email via Gmail SMTP using a Google App Password.
 * Tries port 587 (STARTTLS) first, then 465.
 * @returns {{ ok: boolean, messageId?: string, error?: string }}
 */
export async function sendSmtpEmail({
  fromEmail,
  fromName,
  appPassword,
  toEmail,
  toName,
  subject,
  body,
  inReplyTo,
  references,
}) {
  const user = String(fromEmail || '').trim();
  const pass = String(appPassword || '').trim();
  const to = String(toEmail || '').trim();

  if (!user || !pass || !to) {
    return { ok: false, error: 'fromEmail, appPassword, and toEmail are required' };
  }
  if (!subject || !body) {
    return { ok: false, error: 'subject and body are required' };
  }

  const html = formatEmailBodyForHtmlSend(body);
  const mail = {
    from: fromName ? `"${String(fromName).replace(/"/g, '')}" <${user}>` : user,
    to: toName ? `"${String(toName).replace(/"/g, '')}" <${to}>` : to,
    subject: String(subject),
    html,
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
  };

  smtpSendLog('request', {
    from: user,
    to,
    subject: String(subject).slice(0, 80),
    bodyLen: String(body).length,
  });

  const errors = [];

  for (const endpoint of SMTP_ENDPOINTS) {
    const transporter = createGmailTransporter(user, pass, endpoint);
    try {
      smtpSendLog('trying endpoint', { host: endpoint.host, port: endpoint.port });
      const info = await transporter.sendMail(mail);
      const messageId = info?.messageId || null;
      smtpSendLog('ok', { to, messageId, port: endpoint.port });
      return { ok: true, messageId };
    } catch (err) {
      const error = err?.message || String(err);
      errors.push(`port ${endpoint.port}: ${error}`);
      smtpSendLog('endpoint failed', { port: endpoint.port, error });
    } finally {
      transporter.close();
    }
  }

  const error = errors.join(' | ') || 'SMTP send failed on all endpoints';
  smtpSendLog('failed', { to, error });
  return { ok: false, error };
}

export function hasAppPasswordCredentials(emailRow) {
  return Boolean(String(emailRow?.appPassword || '').trim() && String(emailRow?.address || '').trim());
}
