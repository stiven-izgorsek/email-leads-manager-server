/**
 * Shared sender-domain filters for incoming mail.
 *
 * - ignored_sender: stored, classified as ignored (e.g. LinkedIn), still may appear in inbox UI
 * - hide_sender: stored so we do not re-poll forever; excluded from inbox unless includeHidden
 */

import { AppDataSource } from '../config/database.js';
import { HiddenSenderEntry } from '../entities/HiddenSenderEntry.js';
import { IncomingMessage } from '../entities/IncomingMessage.js';

/** Marketing / platform mail — skip AI classify + Slack; type `ignored_sender`. */
export const IGNORED_SENDER_EMAIL_DOMAINS = [
  'linkedin.com',
  'xing.com',
  'medium.com',
  'indeed.com',
];

/** Seed defaults (also inserted by migration for existing DBs). */
export const DEFAULT_HIDDEN_SENDER_DOMAINS = [
  '7card.co.jp',
  'mail.drivepilothub.com',
  'vehicleinsurancexpert.com',
  'machinelearntech.com',
  'lendinblue.com',
  'autoconvert360.com',
  'naadam.co',
  'vehicleproinsurance.com',
  'auto.autonewssite.com',
  'automatedfintech.com',
  'alerts.protegoinsure.com',
  'autob2btech.com',
  'autoleadverse.com',
  'autolendiq.com',
  'aibenefitsphere.com',
  'jackerwin.com',
  'mail.insuresmarttech.com',
  'alerts.insurextract.com',
  't.tradingcentury.com',
  'thinkcloud.balloonthought.com',
  'quantumautomationpro.com',
  'healthplusauto.com',
  'evonovatech.com',
  'news.healthchoicesales.com',
  'mail.idinspo.com',
  'autoinsurecore.com',
  'revcraftsman.com',
];

export const MESSAGE_TYPE_IGNORED_SENDER = 'ignored_sender';
export const MESSAGE_TYPE_HIDE_SENDER = 'hide_sender';

const CACHE_MS = 15_000;
/** @type {string[] | null} */
let cachedHiddenValues = null;
let cachedAt = 0;

export function invalidateHiddenSenderCache() {
  cachedHiddenValues = null;
  cachedAt = 0;
}

/**
 * Normalize user input to a hide-list value (lowercased domain, or full email).
 * Emails are reduced to their domain so one entry covers all senders there.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeHiddenSenderValue(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  const angle = s.match(/<([^>]+)>/);
  const inner = (angle ? angle[1] : s).trim();
  if (inner.includes('@')) {
    const domain = domainFromEmailAddress(inner);
    return domain || '';
  }
  // Strip leading @ if pasted as @domain.com
  return inner.replace(/^@+/, '').replace(/\/+$/, '');
}

/**
 * @param {string} addr
 * @returns {string}
 */
export function domainFromEmailAddress(addr) {
  const raw = String(addr || '').trim().toLowerCase();
  const angle = raw.match(/<([^>]+)>/);
  const inner = (angle ? angle[1] : raw).trim();
  const at = inner.lastIndexOf('@');
  if (at === -1) return '';
  return inner.slice(at + 1);
}

/**
 * @param {string} domain
 * @param {string[]} suffixes
 */
function domainMatchesAny(domain, suffixes) {
  if (!domain) return false;
  for (const suffix of suffixes) {
    const s = String(suffix || '').trim().toLowerCase();
    if (!s) continue;
    if (domain === s || domain.endsWith('.' + s)) return true;
  }
  return false;
}

/**
 * @param {string[]} fromAddresses
 * @param {string[]} values
 */
function anyFromMatchesHiddenValues(fromAddresses, values) {
  const list = Array.isArray(fromAddresses) ? fromAddresses : [];
  const domains = [];
  const emails = [];
  for (const v of values) {
    const s = String(v || '').trim().toLowerCase();
    if (!s) continue;
    if (s.includes('@')) emails.push(s);
    else domains.push(s);
  }
  for (const item of list) {
    const raw = String(item || '').trim().toLowerCase();
    const angle = raw.match(/<([^>]+)>/);
    const email = (angle ? angle[1] : raw).trim();
    if (emails.includes(email)) return true;
    const domain = domainFromEmailAddress(email);
    if (domainMatchesAny(domain, domains)) return true;
  }
  return false;
}

/**
 * @param {string[]} fromAddresses
 * @param {string[]} suffixes
 */
function anyFromMatchesDomains(fromAddresses, suffixes) {
  const list = Array.isArray(fromAddresses) ? fromAddresses : [];
  for (const item of list) {
    if (domainMatchesAny(domainFromEmailAddress(item), suffixes)) return true;
  }
  return false;
}

/** @param {string[]} fromAddresses */
export function isIgnoredMarketingSender(fromAddresses) {
  return anyFromMatchesDomains(fromAddresses, IGNORED_SENDER_EMAIL_DOMAINS);
}

export async function loadHiddenSenderValues({ force = false } = {}) {
  if (!force && cachedHiddenValues && Date.now() - cachedAt < CACHE_MS) {
    return cachedHiddenValues;
  }
  if (!AppDataSource.isInitialized) {
    return [...DEFAULT_HIDDEN_SENDER_DOMAINS];
  }
  const repo = AppDataSource.getRepository(HiddenSenderEntry);
  const rows = await repo.find({ order: { value: 'ASC' } });
  cachedHiddenValues = rows.map((r) => String(r.value || '').toLowerCase()).filter(Boolean);
  cachedAt = Date.now();
  return cachedHiddenValues;
}

/** Ensure seed rows exist (dev synchronize or empty table). */
export async function ensureDefaultHiddenSenderEntries() {
  if (!AppDataSource.isInitialized) return;
  const repo = AppDataSource.getRepository(HiddenSenderEntry);
  const count = await repo.count();
  if (count > 0) return;
  for (const value of DEFAULT_HIDDEN_SENDER_DOMAINS) {
    try {
      await repo.save(repo.create({ value }));
    } catch {
      // unique race
    }
  }
  invalidateHiddenSenderCache();
}

/** @param {string[]} fromAddresses */
export async function isHiddenSender(fromAddresses) {
  const values = await loadHiddenSenderValues();
  return anyFromMatchesHiddenValues(fromAddresses, values);
}

/**
 * Retag existing inbox rows that match a hidden value so they stay out of the unread inbox.
 * @param {string} value
 */
export async function retagIncomingMessagesForHiddenValue(value) {
  const v = normalizeHiddenSenderValue(value);
  if (!v) return 0;
  const repo = AppDataSource.getRepository(IncomingMessage);
  const qb = repo
    .createQueryBuilder()
    .update(IncomingMessage)
    .set({ messageType: MESSAGE_TYPE_HIDE_SENDER, isRead: true })
    .where('"deletedAt" IS NULL')
    .andWhere('"messageType" <> :hideType', { hideType: MESSAGE_TYPE_HIDE_SENDER });

  if (v.includes('@')) {
    qb.andWhere('LOWER(COALESCE("fromEmail", \'\')) LIKE :exact', { exact: `%${v}%` });
  } else {
    qb.andWhere(
      `(LOWER(COALESCE("fromEmail", '')) LIKE :exact OR LOWER(COALESCE("fromEmail", '')) LIKE :sub)`,
      { exact: `%@${v}`, sub: `%@%.${v}` }
    );
  }
  const result = await qb.execute();
  return result.affected || 0;
}

/**
 * @param {import('typeorm').SelectQueryBuilder<any>} qb
 * @param {string} [alias='m']
 * @param {{ values?: string[] }} [opts]
 */
export async function applyExcludeHiddenSenders(qb, alias = 'm', opts = {}) {
  qb.andWhere(`${alias}.messageType <> :hideSenderType`, {
    hideSenderType: MESSAGE_TYPE_HIDE_SENDER,
  });

  const values = opts.values || (await loadHiddenSenderValues());
  const domains = values.filter((v) => v && !v.includes('@'));
  const emails = values.filter((v) => v && v.includes('@'));
  if (!domains.length && !emails.length) return qb;

  const parts = [];
  const params = {};
  domains.forEach((domain, i) => {
    const exact = `hideDomExact${i}`;
    const sub = `hideDomSub${i}`;
    parts.push(
      `(LOWER(COALESCE(${alias}.fromEmail, '')) LIKE :${exact} OR LOWER(COALESCE(${alias}.fromEmail, '')) LIKE :${sub})`
    );
    params[exact] = `%@${domain}`;
    params[sub] = `%@%.${domain}`;
  });
  emails.forEach((email, i) => {
    const key = `hideEmail${i}`;
    parts.push(`LOWER(COALESCE(${alias}.fromEmail, '')) LIKE :${key}`);
    params[key] = `%${email}%`;
  });
  qb.andWhere(`NOT (${parts.join(' OR ')})`, params);
  return qb;
}

/**
 * @param {import('typeorm').UpdateQueryBuilder<any>} qb
 * @param {{ values?: string[] }} [opts]
 */
export async function applyExcludeHiddenSendersForUpdate(qb, opts = {}) {
  qb.andWhere('"messageType" <> :hideSenderType', {
    hideSenderType: MESSAGE_TYPE_HIDE_SENDER,
  });

  const values = opts.values || (await loadHiddenSenderValues());
  const domains = values.filter((v) => v && !v.includes('@'));
  const emails = values.filter((v) => v && v.includes('@'));
  if (!domains.length && !emails.length) return qb;

  const parts = [];
  const params = {};
  domains.forEach((domain, i) => {
    const exact = `hideDomExact${i}`;
    const sub = `hideDomSub${i}`;
    parts.push(
      `(LOWER(COALESCE("fromEmail", '')) LIKE :${exact} OR LOWER(COALESCE("fromEmail", '')) LIKE :${sub})`
    );
    params[exact] = `%@${domain}`;
    params[sub] = `%@%.${domain}`;
  });
  emails.forEach((email, i) => {
    const key = `hideEmail${i}`;
    parts.push(`LOWER(COALESCE("fromEmail", '')) LIKE :${key}`);
    params[key] = `%${email}%`;
  });
  qb.andWhere(`NOT (${parts.join(' OR ')})`, params);
  return qb;
}
