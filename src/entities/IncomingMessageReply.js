import { EntitySchema } from 'typeorm';

export class IncomingMessageReply {}

export const IncomingMessageReplySchema = new EntitySchema({
  name: 'IncomingMessageReply',
  tableName: 'incoming_message_reply',
  target: IncomingMessageReply,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    incomingMessageId: {
      name: 'incoming_message_id',
      type: 'uuid',
      nullable: false,
    },
    emailAddress: {
      name: 'email_address',
      type: 'varchar',
      length: 255,
      nullable: false,
    },
    toEmail: {
      name: 'to_email',
      type: 'varchar',
      length: 255,
      nullable: false,
    },
    toName: {
      name: 'to_name',
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    subject: {
      type: 'varchar',
      length: 1000,
      nullable: true,
    },
    body: {
      type: 'text',
      nullable: false,
    },
    nylasMessageId: {
      name: 'nylas_message_id',
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    sentAt: {
      name: 'sent_at',
      type: 'timestamp',
      nullable: false,
    },
    createdAt: {
      name: 'created_at',
      type: 'timestamp',
      createDate: true,
    },
  },
  indices: [
    {
      name: 'IDX_incoming_message_reply_incoming',
      columns: ['incomingMessageId'],
    },
  ],
});
