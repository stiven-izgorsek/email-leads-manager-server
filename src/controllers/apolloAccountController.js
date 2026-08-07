import { AppDataSource } from '../config/database.js';
import { ApolloAccount } from '../entities/ApolloAccount.js';

function serializeApolloAccount(row, { includeSecrets = false } = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    email: row.email,
    label: row.label || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasApiKey: Boolean(String(row.apiKey || '').trim()),
  };
  if (includeSecrets) {
    return {
      ...base,
      password: row.password || null,
      apiKey: row.apiKey || null,
    };
  }
  return base;
}

export async function listApolloAccounts(req, res) {
  try {
    const repo = AppDataSource.getRepository(ApolloAccount);
    const rows = await repo
      .createQueryBuilder('a')
      .where('a.deleted_at IS NULL')
      .orderBy('a.createdAt', 'DESC')
      .getMany();
    return res.json({ data: rows.map((r) => serializeApolloAccount(r)) });
  } catch (error) {
    console.error('listApolloAccounts error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createApolloAccount(req, res) {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const apiKey = String(req.body?.apiKey || req.body?.api_key || '').trim();
    const password = req.body?.password != null ? String(req.body.password) : null;
    const label = req.body?.label != null ? String(req.body.label).trim() || null : null;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    if (!apiKey) {
      return res.status(400).json({ error: 'API key is required' });
    }

    const repo = AppDataSource.getRepository(ApolloAccount);
    const row = repo.create({
      email,
      password: password || null,
      apiKey,
      label,
    });
    const saved = await repo.save(row);
    return res.status(201).json(serializeApolloAccount(saved));
  } catch (error) {
    console.error('createApolloAccount error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateApolloAccount(req, res) {
  try {
    const repo = AppDataSource.getRepository(ApolloAccount);
    const row = await repo.findOne({ where: { id: req.params.id } });
    if (!row || row.deletedAt) {
      return res.status(404).json({ error: 'Apollo account not found' });
    }

    if (req.body?.email !== undefined) {
      const email = String(req.body.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid email is required' });
      }
      row.email = email;
    }
    if (req.body?.password !== undefined) {
      row.password = req.body.password != null ? String(req.body.password) : null;
    }
    if (req.body?.apiKey !== undefined || req.body?.api_key !== undefined) {
      const apiKey = String(req.body.apiKey ?? req.body.api_key ?? '').trim();
      if (!apiKey) return res.status(400).json({ error: 'API key is required' });
      row.apiKey = apiKey;
    }
    if (req.body?.label !== undefined) {
      row.label = req.body.label != null ? String(req.body.label).trim() || null : null;
    }

    const saved = await repo.save(row);
    return res.json(serializeApolloAccount(saved));
  } catch (error) {
    console.error('updateApolloAccount error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteApolloAccount(req, res) {
  try {
    const repo = AppDataSource.getRepository(ApolloAccount);
    const row = await repo.findOne({ where: { id: req.params.id } });
    if (!row || row.deletedAt) {
      return res.status(404).json({ error: 'Apollo account not found' });
    }
    row.deletedAt = new Date();
    await repo.save(row);
    return res.json({ success: true });
  } catch (error) {
    console.error('deleteApolloAccount error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export { serializeApolloAccount };
