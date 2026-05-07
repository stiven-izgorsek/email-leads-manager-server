import { EntitySchema } from 'typeorm';

export class IncomingMessage {}

export const IncomingMessageSchema = new EntitySchema({
  name: 'IncomingMessage',
  tableName: 'incoming_message',
  target: IncomingMessage,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    emailAddress: {
      type: 'varchar',
      length: 255,
      nullable: false,
    },
    messageId: {
      type: 'varchar',
      length: 255,
      nullable: false,
    },
    subject: {
      type: 'text',
      nullable: true,
    },
    fromEmail: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    messageType: {
      type: 'varchar',
      length: 100,
      default: 'other',
    },
    receivedAt: {
      type: 'timestamp',
      nullable: true,
    },
    isRead: {
      type: 'boolean',
      default: false,
    },
    createdAt: {
      type: 'timestamp',
      createDate: true,
    },
  },
  uniques: [
    {
      name: 'UQ_incoming_message_email_message',
      columns: ['emailAddress', 'messageId'],
    },
  ],
});

