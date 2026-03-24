import { AppDataSource } from '../config/database.js';
import { Brackets, In } from 'typeorm';
import { Portfolio } from '../entities/Portfolio.js';
import { PortfolioIndustry } from '../entities/PortfolioIndustry.js';
import { PortfolioWorkExperience } from '../entities/PortfolioWorkExperience.js';
import { PortfolioTag } from '../entities/PortfolioTag.js';

function parseBullets(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function buildTagTreeFromFlat(flat) {
  const map = new Map();
  for (const t of flat) {
    map.set(t.id, { id: t.id, name: t.name, children: [] });
  }
  const roots = [];
  for (const t of flat) {
    const node = map.get(t.id);
    if (t.parentId && map.has(t.parentId)) {
      map.get(t.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function serializePortfolio(p) {
  const work = {};
  for (const row of p.workExperience || []) {
    work[row.category] = parseBullets(row.bullets);
  }
  return {
    id: p.id,
    name: p.name,
    websiteUrl: p.websiteUrl,
    credentialUser: p.credentialUser,
    credentialPass: p.credentialPass,
    clientName: p.clientName,
    clientEmail: p.clientEmail,
    script: p.script,
    industries: (p.industries || []).map((i) => i.name),
    workExperience: work,
    tags: buildTagTreeFromFlat(p.tags || []),
    createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
    updatedAt: p.updatedAt instanceof Date ? p.updatedAt.toISOString() : p.updatedAt,
  };
}

function applyPortfolioFilters(qb, query) {
  const p = 'p';
  const search = (query.search || '').trim();
  if (search) {
    qb.andWhere(
      new Brackets((b) => {
        b.where(`${p}.name ILIKE :search`, { search: `%${search}%` })
          .orWhere(`${p}.websiteUrl ILIKE :search`, { search: `%${search}%` })
          .orWhere(`${p}.clientName ILIKE :search`, { search: `%${search}%` })
          .orWhere(`${p}.clientEmail ILIKE :search`, { search: `%${search}%` })
          .orWhere(`${p}.script ILIKE :search`, { search: `%${search}%` })
          .orWhere(`${p}.credentialUser ILIKE :search`, { search: `%${search}%` });
      })
    );
  }

  const name = (query.name || '').trim();
  if (name) qb.andWhere(`${p}.name ILIKE :name`, { name: `%${name}%` });

  const websiteUrl = (query.websiteUrl || '').trim();
  if (websiteUrl) qb.andWhere(`${p}.websiteUrl ILIKE :websiteUrl`, { websiteUrl: `%${websiteUrl}%` });

  const clientName = (query.clientName || '').trim();
  if (clientName) qb.andWhere(`${p}.clientName ILIKE :clientName`, { clientName: `%${clientName}%` });

  const clientEmail = (query.clientEmail || '').trim();
  if (clientEmail) qb.andWhere(`${p}.clientEmail ILIKE :clientEmail`, { clientEmail: `%${clientEmail}%` });

  const credentialUser = (query.credentialUser || '').trim();
  if (credentialUser) {
    qb.andWhere(`${p}.credentialUser ILIKE :credentialUser`, { credentialUser: `%${credentialUser}%` });
  }

  const credentialPass = (query.credentialPass || '').trim();
  if (credentialPass) {
    qb.andWhere(`${p}.credentialPass ILIKE :credentialPass`, { credentialPass: `%${credentialPass}%` });
  }

  const scriptContains = (query.scriptContains || '').trim();
  if (scriptContains) {
    qb.andWhere(`${p}.script ILIKE :scriptContains`, { scriptContains: `%${scriptContains}%` });
  }

  const industries = (query.industries || '').trim();
  const industryParts = industries ? industries.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const industryMatch = ((query.industryMatch || 'any') + '').toLowerCase();

  if (industryParts.length) {
    if (industryMatch === 'all') {
      industryParts.forEach((part, i) => {
        qb.andWhere(
          `EXISTS (SELECT 1 FROM portfolio_industry pi WHERE pi."portfolioId" = ${p}.id AND pi.name ILIKE :ind${i})`,
          { [`ind${i}`]: `%${part}%` }
        );
      });
    } else {
      qb.andWhere(
        new Brackets((b) => {
          industryParts.forEach((part, i) => {
            const param = `indAny${i}`;
            b.orWhere(
              `EXISTS (SELECT 1 FROM portfolio_industry pi WHERE pi."portfolioId" = ${p}.id AND pi.name ILIKE :${param})`,
              { [param]: `%${part}%` }
            );
          });
        })
      );
    }
  }

  const workExperienceCategory = (query.workExperienceCategory || '').trim();
  if (workExperienceCategory) {
    qb.andWhere(
      `EXISTS (SELECT 1 FROM portfolio_work_experience pwe WHERE pwe."portfolioId" = ${p}.id AND pwe.category ILIKE :wec)`,
      { wec: `%${workExperienceCategory}%` }
    );
  }

  const workExperienceContains = (query.workExperienceContains || '').trim();
  if (workExperienceContains) {
    qb.andWhere(
      `EXISTS (SELECT 1 FROM portfolio_work_experience pwe WHERE pwe."portfolioId" = ${p}.id AND pwe.bullets ILIKE :wex)`,
      { wex: `%${workExperienceContains}%` }
    );
  }

  const tagParentName = (query.tagParentName || '').trim();
  if (tagParentName) {
    qb.andWhere(
      `EXISTS (SELECT 1 FROM portfolio_tag pt WHERE pt."portfolioId" = ${p}.id AND pt."parentId" IS NULL AND pt.name ILIKE :tpn)`,
      { tpn: `%${tagParentName}%` }
    );
  }

  const tagChildName = (query.tagChildName || '').trim();
  if (tagChildName) {
    qb.andWhere(
      `EXISTS (SELECT 1 FROM portfolio_tag pt WHERE pt."portfolioId" = ${p}.id AND pt."parentId" IS NOT NULL AND pt.name ILIKE :tcn)`,
      { tcn: `%${tagChildName}%` }
    );
  }

  const tagAny = (query.tagAny || '').trim();
  if (tagAny) {
    qb.andWhere(
      `EXISTS (SELECT 1 FROM portfolio_tag pt WHERE pt."portfolioId" = ${p}.id AND pt.name ILIKE :tany)`,
      { tany: `%${tagAny}%` }
    );
  }
}

async function replaceIndustries(manager, portfolioId, names) {
  await manager.getRepository(PortfolioIndustry).delete({ portfolioId });
  const unique = [...new Set((names || []).map((n) => String(n).trim()).filter(Boolean))];
  if (!unique.length) return;
  const repo = manager.getRepository(PortfolioIndustry);
  await repo.save(unique.map((name) => repo.create({ portfolioId, name })));
}

async function replaceWorkExperience(manager, portfolioId, work) {
  await manager.getRepository(PortfolioWorkExperience).delete({ portfolioId });
  const entries = Object.entries(work || {});
  if (!entries.length) return;
  const repo = manager.getRepository(PortfolioWorkExperience);
  const rows = entries.map(([category, bullets]) =>
    repo.create({
      portfolioId,
      category,
      bullets: JSON.stringify((bullets || []).filter((b) => typeof b === 'string' && b.trim())),
    })
  );
  await repo.save(rows);
}

async function replaceTags(manager, portfolioId, nodes) {
  await manager.getRepository(PortfolioTag).delete({ portfolioId });
  const repo = manager.getRepository(PortfolioTag);
  async function walk(parentId, items) {
    for (const item of items || []) {
      const name = String(item.name || '').trim();
      const children = item.children || [];
      if (!name) {
        if (children.length) await walk(parentId, children);
        continue;
      }
      const row = repo.create({ portfolioId, parentId, name });
      const saved = await repo.save(row);
      if (children.length) await walk(saved.id, children);
    }
  }
  await walk(null, nodes || []);
}

export async function getPortfolios(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const repo = AppDataSource.getRepository(Portfolio);

    const qbCount = repo.createQueryBuilder('p');
    applyPortfolioFilters(qbCount, req.query);
    const total = await qbCount.getCount();

    const qb = repo.createQueryBuilder('p');
    applyPortfolioFilters(qb, req.query);
    qb.orderBy('p.updatedAt', 'DESC').skip(skip).take(limit);
    const slice = await qb.getMany();

    const ids = slice.map((r) => r.id);
    if (ids.length === 0) {
      return res.json({
        data: [],
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      });
    }

    const full = await repo.find({
      where: { id: In(ids) },
      relations: ['industries', 'workExperience', 'tags'],
    });

    const orderMap = new Map(ids.map((id, i) => [id, i]));
    full.sort((a, b) => orderMap.get(a.id) - orderMap.get(b.id));

    const data = full.map(serializePortfolio);
    const totalPages = Math.max(1, Math.ceil(total / limit));

    res.json({
      data,
      page,
      limit,
      total,
      totalPages,
    });
  } catch (error) {
    console.error('getPortfolios error:', error);
    res.status(500).json({ error: 'Failed to list portfolios' });
  }
}

export async function getPortfolio(req, res) {
  try {
    const repo = AppDataSource.getRepository(Portfolio);
    const row = await repo.findOne({
      where: { id: req.params.id },
      relations: ['industries', 'workExperience', 'tags'],
    });
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(serializePortfolio(row));
  } catch (error) {
    console.error('getPortfolio error:', error);
    res.status(500).json({ error: 'Failed to load portfolio' });
  }
}

export async function createPortfolio(req, res) {
  try {
    const body = req.body || {};
    if (!body.name || !body.websiteUrl) {
      return res.status(400).json({ error: 'name and websiteUrl are required' });
    }

    const result = await AppDataSource.transaction(async (manager) => {
      const pRepo = manager.getRepository(Portfolio);
      const p = pRepo.create({
        name: String(body.name).trim(),
        websiteUrl: String(body.websiteUrl).trim(),
        credentialUser: body.credentialUser ?? null,
        credentialPass: body.credentialPass ?? null,
        clientName: body.clientName ?? null,
        clientEmail: body.clientEmail ?? null,
        script: body.script ?? '',
      });
      const saved = await pRepo.save(p);
      await replaceIndustries(manager, saved.id, body.industries);
      await replaceWorkExperience(manager, saved.id, body.workExperience);
      await replaceTags(manager, saved.id, body.tags);
      return pRepo.findOne({
        where: { id: saved.id },
        relations: ['industries', 'workExperience', 'tags'],
      });
    });

    res.status(201).json(serializePortfolio(result));
  } catch (error) {
    console.error('createPortfolio error:', error);
    res.status(500).json({ error: 'Failed to create portfolio' });
  }
}

export async function updatePortfolio(req, res) {
  try {
    const body = req.body || {};
    if (!body.name || !body.websiteUrl) {
      return res.status(400).json({ error: 'name and websiteUrl are required' });
    }

    const repo = AppDataSource.getRepository(Portfolio);
    const existing = await repo.findOne({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const result = await AppDataSource.transaction(async (manager) => {
      const pRepo = manager.getRepository(Portfolio);
      await pRepo.update(
        { id: req.params.id },
        {
          name: String(body.name).trim(),
          websiteUrl: String(body.websiteUrl).trim(),
          credentialUser: body.credentialUser ?? null,
          credentialPass: body.credentialPass ?? null,
          clientName: body.clientName ?? null,
          clientEmail: body.clientEmail ?? null,
          script: body.script ?? '',
        }
      );
      await replaceIndustries(manager, req.params.id, body.industries);
      await replaceWorkExperience(manager, req.params.id, body.workExperience);
      await replaceTags(manager, req.params.id, body.tags);
      return pRepo.findOne({
        where: { id: req.params.id },
        relations: ['industries', 'workExperience', 'tags'],
      });
    });

    res.json(serializePortfolio(result));
  } catch (error) {
    console.error('updatePortfolio error:', error);
    res.status(500).json({ error: 'Failed to update portfolio' });
  }
}

export async function deletePortfolio(req, res) {
  try {
    const repo = AppDataSource.getRepository(Portfolio);
    const r = await repo.delete({ id: req.params.id });
    if (!r.affected) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (error) {
    console.error('deletePortfolio error:', error);
    res.status(500).json({ error: 'Failed to delete portfolio' });
  }
}
