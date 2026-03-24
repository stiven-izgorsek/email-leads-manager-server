import { EntitySchema } from 'typeorm';

export class NylasSlackNotification {}

export const NylasSlackNotificationSchema = new EntitySchema({
  name: 'NylasSlackNotification',
  tableName: 'nylas_slack_notification',
  target: NylasSlackNotification,
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
    createdAt: {
      type: 'timestamp',
      createDate: true,
    },
  },
  uniques: [
    {
      name: 'UQ_nylas_slack_notification_email_message',
      columns: ['emailAddress', 'messageId'],
    },
  ],
});

