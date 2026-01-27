import { AppDataSource } from '../config/database.js';
import { User } from '../entities/User.js';

export async function getUsers(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const search = req.query.search || '';

    const userRepository = AppDataSource.getRepository(User);

    const queryBuilder = userRepository
      .createQueryBuilder('user')
      .where('user.deletedAt IS NULL');

    if (search) {
      queryBuilder.andWhere('user.email ILIKE :search', { search: `%${search}%` });
    }

    const [data, total] = await Promise.all([
      queryBuilder
        .orderBy('user.email', 'ASC')
        .skip(skip)
        .take(limit)
        .getMany(),
      queryBuilder.getCount(),
    ]);

    // Don't send password field
    const usersWithoutPassword = data.map(user => ({
      id: user.id,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }));

    res.json({
      data: usersWithoutPassword,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
