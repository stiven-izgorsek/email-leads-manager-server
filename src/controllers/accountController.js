import { IsNull } from 'typeorm';
import { AppDataSource } from '../config/database.js';
import { Account } from '../entities/Account.js';
import { Email } from '../entities/Email.js';

export async function getAccounts(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const search = (req.query.search || '').trim();

    const accountRepository = AppDataSource.getRepository(Account);

    const queryBuilder = accountRepository
      .createQueryBuilder('account')
      .where('account.deletedAt IS NULL');

    if (search) {
      queryBuilder.andWhere(
        `(account.firstName ILIKE :search OR account.lastName ILIKE :search OR account.country ILIKE :search OR CONCAT(COALESCE(account.firstName, ''), ' ', COALESCE(account.lastName, '')) ILIKE :search)`,
        { search: `%${search}%` }
      );
    }

    const [data, total] = await Promise.all([
      queryBuilder
        .orderBy('account.createdAt', 'DESC')
        .skip(skip)
        .take(limit)
        .getMany(),
      queryBuilder.getCount(),
    ]);

    const emailCounts = {};
    const accountIds = data.map((account) => account.id).filter(Boolean);
    if (accountIds.length) {
      const emailRepository = AppDataSource.getRepository(Email);
      const countRows = await emailRepository
        .createQueryBuilder('email')
        .select('email.accountId', 'accountId')
        .addSelect(
          `SUM(CASE WHEN email.status = 'good' THEN 1 ELSE 0 END)`,
          'goodCount'
        )
        .addSelect(
          `SUM(CASE WHEN email.status <> 'good' OR email.status IS NULL THEN 1 ELSE 0 END)`,
          'otherCount'
        )
        .where('email.deletedAt IS NULL')
        .andWhere('email.accountId IN (:...accountIds)', { accountIds })
        .groupBy('email.accountId')
        .getRawMany();

      for (const row of countRows) {
        const key = String(row.accountId || '');
        if (!key) continue;
        emailCounts[key] = {
          good: Number(row.goodCount || 0),
          other: Number(row.otherCount || 0),
        };
      }
    }

    const enriched = data.map((account) => {
      const counts = emailCounts[account.id] || { good: 0, other: 0 };
      return {
        ...account,
        goodEmailsCount: counts.good,
        otherEmailsCount: counts.other,
        emailsCount: counts.good + counts.other,
      };
    });

    const totalPages = Math.ceil(total / limit);

    res.json({
      data: enriched,
      page,
      limit,
      total,
      totalPages,
    });
  } catch (error) {
    console.error('Get accounts error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getAccount(req, res) {
  try {
    const accountRepository = AppDataSource.getRepository(Account);
    const account = await accountRepository.findOne({
      where: { id: req.params.id, deletedAt: IsNull() },
    });

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    res.json(account);
  } catch (error) {
    console.error('Get account error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createAccount(req, res) {
  try {
    const accountRepository = AppDataSource.getRepository(Account);
    
    // Create new account
    const account = accountRepository.create({
      firstName: req.body.firstName || null,
      lastName: req.body.lastName || null,
      linkedin: req.body.linkedin || null,
      xing: req.body.xing || null,
      cv: req.body.cv || null,
      country: req.body.country || null,
      assignedTo: req.body.assignedTo || null,
    });

    const savedAccount = await accountRepository.save(account);

    res.status(201).json(savedAccount);
  } catch (error) {
    console.error('Create account error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateAccount(req, res) {
  try {
    const accountRepository = AppDataSource.getRepository(Account);
    
    const account = await accountRepository.findOne({
      where: { id: req.params.id, deletedAt: IsNull() },
    });

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Update account fields
    if (req.body.firstName !== undefined) account.firstName = req.body.firstName;
    if (req.body.lastName !== undefined) account.lastName = req.body.lastName;
    if (req.body.linkedin !== undefined) account.linkedin = req.body.linkedin;
    if (req.body.xing !== undefined) account.xing = req.body.xing;
    if (req.body.cv !== undefined) account.cv = req.body.cv;
    if (req.body.country !== undefined) account.country = req.body.country;
    if (req.body.assignedTo !== undefined) account.assignedTo = req.body.assignedTo;

    const updatedAccount = await accountRepository.save(account);

    res.json(updatedAccount);
  } catch (error) {
    console.error('Update account error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteAccount(req, res) {
  try {
    const accountRepository = AppDataSource.getRepository(Account);
    
    const account = await accountRepository.findOne({
      where: { id: req.params.id, deletedAt: IsNull() },
    });

    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    // Soft delete
    account.deletedAt = new Date();
    await accountRepository.save(account);

    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
