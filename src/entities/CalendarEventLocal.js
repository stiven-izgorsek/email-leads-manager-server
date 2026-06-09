import { EntitySchema } from 'typeorm';

export class CalendarEventLocal {
  constructor(
    id,
    emailId,
    mailboxEmail,
    title,
    description,
    location,
    startAt,
    endAt,
    allDay,
    recurrenceFrequency,
    recurrenceInterval,
    recurrenceEndAt,
    deletedAt,
    createdAt,
    updatedAt
  ) {
    this.id = id;
    this.emailId = emailId;
    this.mailboxEmail = mailboxEmail;
    this.title = title;
    this.description = description;
    this.location = location;
    this.startAt = startAt;
    this.endAt = endAt;
    this.allDay = allDay;
    this.recurrenceFrequency = recurrenceFrequency;
    this.recurrenceInterval = recurrenceInterval;
    this.recurrenceEndAt = recurrenceEndAt;
    this.deletedAt = deletedAt;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
}

export const CalendarEventLocalSchema = new EntitySchema({
  name: 'CalendarEventLocal',
  tableName: 'calendar_event_local',
  target: CalendarEventLocal,
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
    mailboxEmail: {
      name: 'mailbox_email',
      type: 'varchar',
      length: 255,
      nullable: false,
    },
    title: {
      type: 'varchar',
      length: 1000,
      nullable: false,
      default: '(no title)',
    },
    description: {
      type: 'text',
      nullable: true,
    },
    location: {
      type: 'varchar',
      length: 1000,
      nullable: true,
    },
    startAt: {
      name: 'start_at',
      type: 'timestamp',
      nullable: false,
    },
    endAt: {
      name: 'end_at',
      type: 'timestamp',
      nullable: false,
    },
    allDay: {
      name: 'all_day',
      type: 'boolean',
      default: false,
    },
    recurrenceFrequency: {
      name: 'recurrence_frequency',
      type: 'varchar',
      length: 32,
      nullable: true,
    },
    recurrenceInterval: {
      name: 'recurrence_interval',
      type: 'int',
      default: 1,
    },
    recurrenceEndAt: {
      name: 'recurrence_end_at',
      type: 'timestamp',
      nullable: true,
    },
    deletedAt: {
      name: 'deleted_at',
      type: 'timestamp',
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
  },
  indices: [
    {
      name: 'idx_calendar_event_local_email_start',
      columns: ['emailId', 'startAt'],
    },
    {
      name: 'idx_calendar_event_local_range',
      columns: ['startAt', 'endAt'],
    },
  ],
});
