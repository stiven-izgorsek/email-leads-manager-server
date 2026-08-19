import { EntitySchema } from 'typeorm';

export class CalendarSlackNotification {}

export const CalendarSlackNotificationSchema = new EntitySchema({
  name: 'CalendarSlackNotification',
  tableName: 'calendar_slack_notification',
  target: CalendarSlackNotification,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    eventKey: {
      name: 'event_key',
      type: 'varchar',
      length: 500,
      nullable: false,
    },
    occurrenceStart: {
      name: 'occurrence_start',
      type: 'timestamp',
      nullable: false,
    },
    title: {
      type: 'varchar',
      length: 1000,
      nullable: true,
    },
    mailboxEmail: {
      name: 'mailbox_email',
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    createdAt: {
      type: 'timestamp',
      createDate: true,
    },
  },
  uniques: [
    {
      name: 'UQ_calendar_slack_notification_event_occurrence',
      columns: ['eventKey', 'occurrenceStart'],
    },
  ],
  indices: [
    {
      name: 'idx_calendar_slack_notification_occurrence',
      columns: ['occurrenceStart'],
    },
  ],
});
