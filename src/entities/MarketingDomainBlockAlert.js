import { EntitySchema } from 'typeorm';

export class MarketingDomainBlockAlert {}

export const MarketingDomainBlockAlertSchema = new EntitySchema({
  name: 'MarketingDomainBlockAlert',
  tableName: 'marketing_domain_block_alert',
  target: MarketingDomainBlockAlert,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    emailId: {
      name: 'email_id',
      type: 'uuid',
      nullable: false,
    },
    emailAddress: {
      name: 'email_address',
      type: 'varchar',
      length: 320,
      nullable: false,
    },
    incomingMessageId: {
      name: 'incoming_message_id',
      type: 'uuid',
      nullable: true,
    },
    externalMessageId: {
      name: 'external_message_id',
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    subject: {
      type: 'varchar',
      length: 1000,
      nullable: true,
    },
    snippet: {
      type: 'text',
      nullable: true,
    },
    status: {
      type: 'varchar',
      length: 32,
      default: 'pending',
    },
    createdAt: {
      type: 'timestamp',
      createDate: true,
    },
    acknowledgedAt: {
      name: 'acknowledged_at',
      type: 'timestamp',
      nullable: true,
    },
  },
  indices: [
    {
      name: 'idx_marketing_domain_block_alert_status',
      columns: ['status'],
    },
    {
      name: 'idx_marketing_domain_block_alert_email',
      columns: ['emailId'],
    },
  ],
});
