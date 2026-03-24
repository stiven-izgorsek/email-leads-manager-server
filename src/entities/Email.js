import { EntitySchema } from 'typeorm';

export class Email {
  constructor(id, address, accountId, status, password, twoFa, recoveryEmail, grantId, nylasKey, createdAt, updatedAt, deletedAt) {
    this.id = id;
    this.address = address;
    this.accountId = accountId;
    this.status = status;
    this.password = password;
    this.twoFa = twoFa;
    this.recoveryEmail = recoveryEmail;
    this.grantId = grantId;
    this.nylasKey = nylasKey;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.deletedAt = deletedAt;
  }
}

export const EmailSchema = new EntitySchema({
  name: 'Email',
  target: Email,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    address: {
      type: 'varchar',
      length: 255,
      nullable: false,
    },
    accountId: {
      type: 'uuid',
      nullable: true,
    },
    status: {
      type: 'varchar',
      length: 50,
      nullable: false,
      default: 'new',
    },
    password: {
      type: 'varchar',
      nullable: true,
    },
    twoFa: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    recoveryEmail: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    grantId: {
      name: 'grant_id',
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    nylasKey: {
      name: 'nylas_key',
      type: 'varchar',
      length: 1000,
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
      type: 'timestamp',
      nullable: true,
    },
  },
  relations: {
    account: {
      type: 'many-to-one',
      target: 'Account',
      joinColumn: { name: 'accountId', referencedColumnName: 'id' },
    },
  },
});
