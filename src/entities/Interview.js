import { EntitySchema } from 'typeorm';

export class Interview {
  constructor(id, clientId, emailId, step, link, time, result, createdAt, updatedAt, deletedAt) {
    this.id = id;
    this.clientId = clientId;
    this.emailId = emailId;
    this.step = step;
    this.link = link;
    this.time = time;
    this.result = result;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.deletedAt = deletedAt;
  }
}

export const InterviewSchema = new EntitySchema({
  name: 'Interview',
  target: Interview,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    clientId: {
      type: 'uuid',
      nullable: false,
    },
    emailId: {
      type: 'uuid',
      nullable: false,
    },
    step: {
      type: 'int',
      nullable: false,
    },
    link: {
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    time: {
      type: 'timestamp',
      nullable: true,
    },
    result: {
      type: 'varchar',
      length: 50,
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
    client: {
      type: 'many-to-one',
      target: 'Client',
      joinColumn: { name: 'clientId', referencedColumnName: 'id' },
    },
    email: {
      type: 'many-to-one',
      target: 'Email',
      joinColumn: { name: 'emailId', referencedColumnName: 'id' },
    },
  },
});
