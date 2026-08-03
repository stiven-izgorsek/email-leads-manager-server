import { EntitySchema } from 'typeorm';

export class ApolloAccount {
  constructor(id, email, password, apiKey, label, createdAt, updatedAt, deletedAt) {
    this.id = id;
    this.email = email;
    this.password = password;
    this.apiKey = apiKey;
    this.label = label;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.deletedAt = deletedAt;
  }
}

export const ApolloAccountSchema = new EntitySchema({
  name: 'ApolloAccount',
  tableName: 'apollo_account',
  target: ApolloAccount,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    email: {
      type: 'varchar',
      length: 255,
      nullable: false,
    },
    password: {
      type: 'varchar',
      length: 1000,
      nullable: true,
    },
    apiKey: {
      name: 'api_key',
      type: 'varchar',
      length: 1000,
      nullable: false,
    },
    label: {
      type: 'varchar',
      length: 255,
      nullable: true,
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
      name: 'deleted_at',
      type: 'timestamp',
      nullable: true,
    },
  },
});
