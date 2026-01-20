import { EntitySchema } from 'typeorm';

export class Account {
  constructor(id, firstName, lastName, linkedin, xing, cv, country, assignedTo, createdAt, updatedAt, deletedAt) {
    this.id = id;
    this.firstName = firstName;
    this.lastName = lastName;
    this.linkedin = linkedin;
    this.xing = xing;
    this.cv = cv;
    this.country = country;
    this.assignedTo = assignedTo;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.deletedAt = deletedAt;
  }
}

export const AccountSchema = new EntitySchema({
  name: 'Account',
  target: Account,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    firstName: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    lastName: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    linkedin: {
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    xing: {
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    cv: {
      type: 'text',
      nullable: true,
    },
    country: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    assignedTo: {
      type: 'uuid',
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
    assignedToUser: {
      type: 'many-to-one',
      target: 'User',
      joinColumn: { name: 'assignedTo', referencedColumnName: 'id' },
    },
  },
});
