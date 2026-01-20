import { AppDataSource } from '../config/database.js';
import { Email } from '../entities/Email.js';

export async function getEmails(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const emailRepository = AppDataSource.getRepository(Email);

    const queryBuilder = emailRepository
      .createQueryBuilder('email')
      .leftJoinAndSelect('email.account', 'account')
      .where('email.deletedAt IS NULL');

    if (req.query.search) {
      queryBuilder.andWhere('email.address ILIKE :search', { search: `%${req.query.search}%` });
    }

    const dataQuery = queryBuilder
      .orderBy('email.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    // Create a separate query for count
    const countQuery = emailRepository
      .createQueryBuilder('email')
      .where('email.deletedAt IS NULL');
    
    if (req.query.search) {
      countQuery.andWhere('email.address ILIKE :search', { search: `%${req.query.search}%` });
    }

    const [data, total] = await Promise.all([
      dataQuery.getMany(),
      countQuery.getCount(),
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
    console.error('Get emails error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createEmail(req, res) {
  try {
    if (!req.body.address && !req.body.email) {
      return res.status(400).json({ error: 'Email address is required' });
    }

    const emailRepository = AppDataSource.getRepository(Email);
    
    const emailAddress = (req.body.address || req.body.email).toLowerCase();
    
    // Check if email already exists
    const existingEmail = await emailRepository.findOne({
      where: { address: emailAddress, deletedAt: null },
    });

    if (existingEmail) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const emailData = {
      address: emailAddress,
      accountId: req.body.accountId || null,
      status: req.body.status || 'new',
      password: req.body.password || null,
      twoFa: req.body.twoFa || req.body['2fa'] || null,
      recoveryEmail: req.body.recoveryEmail || null,
    };

    const email = emailRepository.create(emailData);
    const savedEmail = await emailRepository.save(email);

    // Load with relation
    const emailWithAccount = await emailRepository.findOne({
      where: { id: savedEmail.id },
      relations: ['account'],
    });

    res.status(201).json(emailWithAccount);
  } catch (error) {
    console.error('Create email error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
}
