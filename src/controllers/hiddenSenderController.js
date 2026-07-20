import { AppDataSource } from '../config/database.js';
import { HiddenSenderEntry } from '../entities/HiddenSenderEntry.js';
import {
  ensureDefaultHiddenSenderEntries,
  invalidateHiddenSenderCache,
  loadHiddenSenderValues,
  normalizeHiddenSenderValue,
  retagIncomingMessagesForHiddenValue,
} from '../services/incomingSenderFilterService.js';

export async function listHiddenSenderEntries(req, res) {
  try {
    await ensureDefaultHiddenSenderEntries();
    const repo = AppDataSource.getRepository(HiddenSenderEntry);
    const data = await repo.find({ order: { value: 'ASC' } });
    res.json({ data });
  } catch (error) {
    console.error('listHiddenSenderEntries error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createHiddenSenderEntry(req, res) {
  try {
    const value = normalizeHiddenSenderValue(req.body?.value || req.body?.domain || req.body?.email);
    if (!value) {
      return res.status(400).json({ error: 'value is required (domain or email)' });
    }

    const repo = AppDataSource.getRepository(HiddenSenderEntry);
    const existing = await repo.findOne({ where: { value } });
    if (existing) {
      return res.json({ data: existing, created: false, retagged: 0 });
    }

    const row = await repo.save(repo.create({ value }));
    invalidateHiddenSenderCache();
    const retagged = await retagIncomingMessagesForHiddenValue(value);
    res.status(201).json({ data: row, created: true, retagged });
  } catch (error) {
    if (error?.code === '23505') {
      const value = normalizeHiddenSenderValue(req.body?.value || req.body?.domain || req.body?.email);
      const repo = AppDataSource.getRepository(HiddenSenderEntry);
      const existing = await repo.findOne({ where: { value } });
      return res.json({ data: existing, created: false, retagged: 0 });
    }
    console.error('createHiddenSenderEntry error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteHiddenSenderEntry(req, res) {
  try {
    const idOrValue = String(req.params.idOrValue || '').trim();
    if (!idOrValue) return res.status(400).json({ error: 'id or value required' });

    const repo = AppDataSource.getRepository(HiddenSenderEntry);
    let row = null;
    const looksUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      idOrValue
    );
    if (looksUuid) {
      row = await repo.findOne({ where: { id: idOrValue } });
    }
    if (!row) {
      const value = normalizeHiddenSenderValue(idOrValue) || idOrValue.toLowerCase();
      row = await repo.findOne({ where: { value } });
    }
    if (!row) return res.status(404).json({ error: 'Not found' });

    await repo.remove(row);
    invalidateHiddenSenderCache();
    // Note: we do not un-hide already-tagged messages (keep them as hide_sender).
    res.json({ ok: true, deleted: row.value });
  } catch (error) {
    console.error('deleteHiddenSenderEntry error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** Convenience: current values only (for select boxes). */
export async function listHiddenSenderValues(req, res) {
  try {
    await ensureDefaultHiddenSenderEntries();
    const values = await loadHiddenSenderValues({ force: true });
    res.json({ data: values });
  } catch (error) {
    console.error('listHiddenSenderValues error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
