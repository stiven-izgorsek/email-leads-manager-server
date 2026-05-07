import { AppDataSource } from '../config/database.js';
import { IncomingMessage } from '../entities/IncomingMessage.js';
import { MessageTypeRule } from '../entities/MessageTypeRule.js';
import { Email } from '../entities/Email.js';
import {
  classifyIncomingMessage,
  ensureDefaultMessageTypeRules,
  loadMessageTypeRules,
} from '../services/messageTypeService.js';
import { analyzeNylasMessagesForPeriod } from '../services/nylasPeriodAnalysisService.js';

const configuredNylasRegion = (process.env.NYLAS_REGION || '').toLowerCase();

function getNylasBaseUrls() {
  if (configuredNylasRegion === 'us') return ['https://api.us.nylas.com'];
  if (configuredNylasRegion === 'eu') return ['https://api.eu.nylas.com'];
  return ['https://api.eu.nylas.com', 'https://api.us.nylas.com'];
}

function normalizeList(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === 'string') return item;
      const name = String(item?.name || '').trim();
      const email = String(item?.email || '').trim();
      if (name && email) return `${name} <${email}>`;
      return email || '';
    })
    .filter(Boolean);
}

/** Nylas sometimes returns `body` as a string; older/alternate shapes may nest HTML/text. */
function extractNylasMessageBody(message) {
  if (!message) return '';
  const b = message.body;
  if (typeof b === 'string') return b;
  if (b != null && typeof b === 'object') {
    if (typeof b.value === 'string') return b.value;
    if (typeof b.content === 'string') return b.content;
  }
  if (typeof message.text === 'string') return message.text;
  if (typeof message.snippet === 'string') return message.snippet;
  return '';
}

async function fetchNylasMessageById(grantId, nylasKey, messageId) {
  let lastError = null;
  for (const baseUrl of getNylasBaseUrls()) {
    try {
      const response = await fetch(`${baseUrl}/v3/grants/${grantId}/messages/${messageId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${nylasKey}`,
          Accept: 'application/json',
        },
      });
      if (response.ok) {
        const payload = await response.json();
        return payload?.data || payload;
      }
      const text = await response.text().catch(() => '');
      const err = new Error(`Nylas fetch failed (${response.status}) on ${baseUrl}: ${text || response.statusText}`);
      err.status = response.status;
      lastError = err;
      // In auto region mode, keep trying the next region even on 401/403,
      // because some mailboxes are valid only on the other Nylas base URL.
      if (configuredNylasRegion) break;
    } catch (error) {
      lastError = error;
      if (configuredNylasRegion) break;
    }
  }
  throw lastError || new Error('Failed to fetch message from Nylas');
}

export async function listIncomingMessages(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const repo = AppDataSource.getRepository(IncomingMessage);
    const qb = repo.createQueryBuilder('m');

    if (req.query.emailAddress) {
      qb.andWhere('m.emailAddress ILIKE :emailAddress', { emailAddress: `%${req.query.emailAddress}%` });
    }
    if (req.query.type) {
      qb.andWhere('m.messageType = :type', { type: req.query.type });
    }
    if (req.query.search) {
      qb.andWhere(
        '(m.subject ILIKE :search OR m.messageId ILIKE :search OR m.emailAddress ILIKE :search)',
        { search: `%${req.query.search}%` }
      );
    }
    const todayOnly = String(req.query.todayOnly || 'true').toLowerCase() !== 'false';
    if (todayOnly) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      qb.andWhere('COALESCE(m.receivedAt, m.createdAt) >= :start AND COALESCE(m.receivedAt, m.createdAt) <= :end', {
        start,
        end,
      });
    }

    const [data, total] = await Promise.all([
      qb.orderBy('COALESCE(m.receivedAt, m.createdAt)', 'DESC').skip(skip).take(limit).getMany(),
      qb.clone().getCount(),
    ]);

    res.json({
      data,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error('listIncomingMessages error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getIncomingUnreadCount(req, res) {
  try {
    const repo = AppDataSource.getRepository(IncomingMessage);
    const qb = repo.createQueryBuilder('m').where('m.isRead = :isRead', { isRead: false });
    const todayOnly = String(req.query.todayOnly || 'true').toLowerCase() !== 'false';
    if (todayOnly) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      qb.andWhere('COALESCE(m.receivedAt, m.createdAt) >= :start AND COALESCE(m.receivedAt, m.createdAt) <= :end', {
        start,
        end,
      });
    }
    const unread = await qb.getCount();
    res.json({ unread });
  } catch (error) {
    console.error('getIncomingUnreadCount error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function markAllIncomingAsRead(req, res) {
  try {
    const repo = AppDataSource.getRepository(IncomingMessage);
    const todayOnly = String(req.body?.todayOnly ?? 'true').toLowerCase() !== 'false';
    const qb = repo
      .createQueryBuilder()
      .update(IncomingMessage)
      .set({ isRead: true })
      .where('isRead = :isRead', { isRead: false });

    if (todayOnly) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      qb.andWhere('COALESCE(receivedAt, createdAt) >= :start AND COALESCE(receivedAt, createdAt) <= :end', {
        start,
        end,
      });
    }

    const result = await qb.execute();
    res.json({ updated: result.affected || 0 });
  } catch (error) {
    console.error('markAllIncomingAsRead error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function listLatestUnreadIncoming(req, res) {
  try {
    const repo = AppDataSource.getRepository(IncomingMessage);
    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit, 10) || 3));
    const qb = repo.createQueryBuilder('m').where('m.isRead = :isRead', { isRead: false });
    const todayOnly = String(req.query.todayOnly || 'true').toLowerCase() !== 'false';
    if (todayOnly) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      qb.andWhere('COALESCE(m.receivedAt, m.createdAt) >= :start AND COALESCE(m.receivedAt, m.createdAt) <= :end', {
        start,
        end,
      });
    }

    const rows = await qb
      .orderBy('COALESCE(m.receivedAt, m.createdAt)', 'DESC')
      .take(limit)
      .getMany();

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        emailAddress: r.emailAddress,
        fromEmail: r.fromEmail || '',
        subject: r.subject || '',
      })),
    });
  } catch (error) {
    console.error('listLatestUnreadIncoming error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function listIncomingMessageTypeCounts(req, res) {
  try {
    const repo = AppDataSource.getRepository(IncomingMessage);
    const rows = await repo
      .createQueryBuilder('m')
      .select('m.emailAddress', 'emailAddress')
      .addSelect('m.messageType', 'messageType')
      .addSelect('COUNT(*)', 'count')
      .groupBy('m.emailAddress')
      .addGroupBy('m.messageType')
      .orderBy('m.emailAddress', 'ASC')
      .getRawMany();

    const map = new Map();
    for (const row of rows) {
      const emailAddress = row.emailAddress;
      const messageType = row.messageType || 'other';
      const count = Number(row.count || 0);
      if (!map.has(emailAddress)) {
        map.set(emailAddress, {
          emailAddress,
          total: 0,
          counts: {},
        });
      }
      const item = map.get(emailAddress);
      item.total += count;
      item.counts[messageType] = count;
    }

    res.json({ data: Array.from(map.values()) });
  } catch (error) {
    console.error('listIncomingMessageTypeCounts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function listMessageTypeRules(req, res) {
  try {
    await ensureDefaultMessageTypeRules();
    const data = await loadMessageTypeRules();
    res.json({ data });
  } catch (error) {
    console.error('listMessageTypeRules error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createMessageTypeRule(req, res) {
  try {
    const type = String(req.body.type || '').trim().toLowerCase();
    const pattern = String(req.body.pattern || '').trim();
    if (!type || !pattern) {
      return res.status(400).json({ error: 'type and pattern are required' });
    }

    const repo = AppDataSource.getRepository(MessageTypeRule);
    const rule = repo.create({
      type,
      pattern,
    });
    const saved = await repo.save(rule);
    res.status(201).json(saved);
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(400).json({ error: 'Rule already exists' });
    }
    console.error('createMessageTypeRule error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateMessageTypeRule(req, res) {
  try {
    const repo = AppDataSource.getRepository(MessageTypeRule);
    const row = await repo.findOne({ where: { id: req.params.id } });
    if (!row) return res.status(404).json({ error: 'Rule not found' });

    if (req.body.type !== undefined) row.type = String(req.body.type || '').trim().toLowerCase();
    if (req.body.pattern !== undefined) row.pattern = String(req.body.pattern || '').trim();
    if (!row.type || !row.pattern) {
      return res.status(400).json({ error: 'type and pattern are required' });
    }

    const saved = await repo.save(row);
    res.json(saved);
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(400).json({ error: 'Rule already exists' });
    }
    console.error('updateMessageTypeRule error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteMessageTypeRule(req, res) {
  try {
    const repo = AppDataSource.getRepository(MessageTypeRule);
    const result = await repo.delete({ id: req.params.id });
    if (!result.affected) return res.status(404).json({ error: 'Rule not found' });
    res.status(204).send();
  } catch (error) {
    console.error('deleteMessageTypeRule error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Renames a message type everywhere: all rules with `fromType`, and stored incoming_message rows.
 */
export async function renameMessageTypeForRules(req, res) {
  try {
    const fromType = String(req.body.fromType || '').trim().toLowerCase();
    const toType = String(req.body.toType || '').trim().toLowerCase();
    if (!fromType || !toType) {
      return res.status(400).json({ error: 'fromType and toType are required' });
    }
    if (fromType === toType) {
      return res.status(400).json({ error: 'New type must differ from the current type' });
    }

    const ruleRepo = AppDataSource.getRepository(MessageTypeRule);
    const incomingRepo = AppDataSource.getRepository(IncomingMessage);

    const movingRules = await ruleRepo.find({ where: { type: fromType } });
    const incomingCount = await incomingRepo.count({ where: { messageType: fromType } });

    if (movingRules.length === 0 && incomingCount === 0) {
      return res.status(404).json({ error: 'No rules or stored messages use this message type' });
    }

    if (movingRules.length > 0) {
      const existingAtTarget = await ruleRepo.find({ where: { type: toType } });
      const patternsAtTarget = new Set(existingAtTarget.map((r) => r.pattern));
      for (const r of movingRules) {
        if (patternsAtTarget.has(r.pattern)) {
          return res.status(400).json({
            error: `Cannot rename: a rule with the same phrase already exists for type "${toType}".`,
          });
        }
      }
    }

    await AppDataSource.transaction(async (manager) => {
      if (movingRules.length > 0) {
        await manager.getRepository(MessageTypeRule).update({ type: fromType }, { type: toType });
      }
      if (incomingCount > 0) {
        await manager.getRepository(IncomingMessage).update({ messageType: fromType }, { messageType: toType });
      }
    });

    res.json({
      ok: true,
      rulesUpdated: movingRules.length,
      incomingMessagesUpdated: incomingCount,
    });
  } catch (error) {
    console.error('renameMessageTypeForRules error:', error);
    if (error?.code === '23505') {
      return res.status(400).json({ error: 'Rename would violate unique rule constraints' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
}

const ANALYSIS_PRESETS = [
  'today',
  'this_week',
  'this_month',
  'last_n_days',
  'last_n_weeks',
  'last_n_months',
];

export async function analyzeIncomingMessagesPeriod(req, res) {
  try {
    const preset = String(req.body?.preset || '').trim();
    const nRaw = req.body?.n;
    const n = nRaw === undefined || nRaw === '' ? undefined : parseInt(String(nRaw), 10);

    if (!ANALYSIS_PRESETS.includes(preset)) {
      return res.status(400).json({ error: 'Invalid preset' });
    }

    const needsN = preset.startsWith('last_n_');
    if (needsN && (!Number.isFinite(n) || n < 1)) {
      return res.status(400).json({ error: 'n must be a positive integer for this period' });
    }

    const result = await analyzeNylasMessagesForPeriod({ preset, n: needsN ? n : undefined });
    res.json(result);
  } catch (error) {
    console.error('analyzeIncomingMessagesPeriod error:', error);
    res.status(500).json({ error: error?.message || 'Internal server error' });
  }
}

export async function classifyMessagePreview(req, res) {
  try {
    await ensureDefaultMessageTypeRules();
    const rules = await loadMessageTypeRules();
    const result = await classifyIncomingMessage({
      subject: req.body.subject,
      body: req.body.body,
      fromEmail: req.body.fromEmail,
      toEmail: req.body.toEmail,
      rules,
    });
    res.json(result);
  } catch (error) {
    console.error('classifyMessagePreview error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getIncomingMessageContent(req, res) {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id is required' });

    const incomingRepo = AppDataSource.getRepository(IncomingMessage);
    const incoming = await incomingRepo.findOne({ where: { id } });
    if (!incoming) return res.status(404).json({ error: 'Incoming message not found' });

    const emailRepo = AppDataSource.getRepository(Email);
    const mailbox = await emailRepo.findOne({
      where: { address: incoming.emailAddress, deletedAt: null },
    });
    if (!mailbox?.grantId || !mailbox?.nylasKey) {
      return res.status(400).json({ error: 'Mailbox is missing Nylas credentials' });
    }

    const message = await fetchNylasMessageById(mailbox.grantId, mailbox.nylasKey, incoming.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found in Nylas' });

    if (!incoming.isRead) {
      incoming.isRead = true;
      await incomingRepo.save(incoming);
    }

    const body = extractNylasMessageBody(message);
    res.json({
      id: incoming.id,
      messageId: incoming.messageId,
      emailAddress: incoming.emailAddress,
      subject: message.subject || incoming.subject || '',
      body: body || message.snippet || '',
      snippet: message.snippet || '',
      from: normalizeList(message.from),
      to: normalizeList(message.to),
      date: message.date || null,
      receivedAt: incoming.receivedAt || null,
      isRead: true,
    });
  } catch (error) {
    console.error('getIncomingMessageContent error:', error);
    const msg = String(error?.message || '');
    if (msg.includes('Nylas fetch failed (401)') || msg.toLowerCase().includes('invalid api key')) {
      return res.status(502).json({
        error: 'Nylas authentication failed for this mailbox (invalid API key). Reconnect/update mailbox credentials.',
      });
    }
    if (msg.includes('Nylas fetch failed (403)')) {
      return res.status(502).json({
        error: 'Nylas access denied for this mailbox. Check grant/API key permissions.',
      });
    }
    res.status(500).json({ error: 'Failed to load incoming message content' });
  }
}

