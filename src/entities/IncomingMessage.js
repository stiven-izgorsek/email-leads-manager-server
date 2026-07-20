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
    toEmail: {
      name: 'to_email',
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    messageType: {
      type: 'varchar',
      length: 100,
      default: 'other',
    },
    /** 'nylas' | 'app_password' */
    source: {
      type: 'varchar',
      length: 32,
      default: 'nylas',
    },
    bodyHtml: {
      name: 'body_html',
      type: 'text',
      nullable: true,
    },
    bodyText: {
      name: 'body_text',
      type: 'text',
      nullable: true,
    },
    receivedAt: {
      type: 'timestamp',
      nullable: true,
    },
    isRead: {
      type: 'boolean',
      default: false,
    },
    /** Soft-delete: row kept so Nylas polling does not recreate the same message. */
    deletedAt: {
      type: 'timestamp',
      nullable: true,
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

