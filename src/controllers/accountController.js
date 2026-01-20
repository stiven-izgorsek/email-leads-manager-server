import { AppDataSource } from '../config/database.js';
import { Account } from '../entities/Account.js';

export async function getAccounts(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const accountRepository = AppDataSource.getRepository(Account);

    const [data, total] = await Promise.all([
      accountRepository.find({
        where: { deletedAt: null },
        order: { createdAt: 'DESC' },
        skip: skip,
        take: limit,
      }),
      accountRepository.count({
        where: { deletedAt: null },
      }),
    ]);

    const totalPages = Math.ceil(total / limit);

    res.json({
      data,
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
      where: { id: req.params.id, deletedAt: null },
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
      where: { id: req.params.id, deletedAt: null },
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
      where: { id: req.params.id, deletedAt: null },
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

