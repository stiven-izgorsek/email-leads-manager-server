import { EntitySchema } from 'typeorm';
import bcrypt from 'bcryptjs';

export class User {
  constructor(id, email, password, role, createdAt, updatedAt, deletedAt) {
    this.id = id;
    this.email = email;
    this.password = password;
    this.role = role;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.deletedAt = deletedAt;
  }

  async comparePassword(candidatePassword) {
    if (!candidatePassword) {
      return false;
    }
    try {
      return await bcrypt.compare(candidatePassword, this.password);
    } catch (error) {
      return false;
    }
  }
}

export const UserSchema = new EntitySchema({
  name: 'User',
  target: User,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    email: {
      type: 'varchar',
      length: 255,
      unique: true,
      nullable: false,
    },
    password: {
      type: 'varchar',
      nullable: false,
    },
    role: {
      type: 'varchar',
      length: 50,
      nullable: false,
      default: 'VA',
    },
    createdAt: {
      type: 'timestamp',
      createDate: true,
    },
    updatedAt: {
      type: 'timestamp',
      updateDate: true,
    },
    deletedAt: {
      type: 'timestamp',
      nullable: true,
    },
  },
});
