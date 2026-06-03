import { EntitySchema } from 'typeorm';

export class CalendarEvent {
  constructor(
    id,
    emailId,
    mailboxEmail,
    grantId,
    nylasEventId,
    title,
    description,
    startAt,
    endAt,
    allDay,
    location,
    htmlLink,
    meetingUrl,
    meetingProvider,
    eventStatus,
    organizerName,
    organizerEmail,
    participantsJson,
    syncedAt,
    createdAt,
    updatedAt
  ) {
    this.id = id;
    this.emailId = emailId;
    this.mailboxEmail = mailboxEmail;
    this.grantId = grantId;
    this.nylasEventId = nylasEventId;
    this.title = title;
    this.description = description;
    this.startAt = startAt;
    this.endAt = endAt;
    this.allDay = allDay;
    this.location = location;
    this.htmlLink = htmlLink;
    this.meetingUrl = meetingUrl;
    this.meetingProvider = meetingProvider;
    this.eventStatus = eventStatus;
    this.organizerName = organizerName;
    this.organizerEmail = organizerEmail;
    this.participantsJson = participantsJson;
    this.syncedAt = syncedAt;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
}

export const CalendarEventSchema = new EntitySchema({
  name: 'CalendarEvent',
  tableName: 'calendar_event',
  target: CalendarEvent,
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
    grantId: {
      name: 'grant_id',
      type: 'varchar',
      length: 255,
      nullable: false,
    },
    nylasEventId: {
      name: 'nylas_event_id',
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
    location: {
      type: 'varchar',
      length: 1000,
      nullable: true,
    },
    htmlLink: {
      name: 'html_link',
      type: 'varchar',
      length: 2000,
      nullable: true,
    },
    meetingUrl: {
      name: 'meeting_url',
      type: 'varchar',
      length: 2000,
      nullable: true,
    },
    meetingProvider: {
      name: 'meeting_provider',
      type: 'varchar',
      length: 64,
      nullable: true,
    },
    description: {
      type: 'text',
      nullable: true,
    },
    eventStatus: {
      name: 'event_status',
      type: 'varchar',
      length: 64,
      nullable: true,
    },
    organizerName: {
      name: 'organizer_name',
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    organizerEmail: {
      name: 'organizer_email',
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    participantsJson: {
      name: 'participants_json',
      type: 'jsonb',
      nullable: true,
    },
    syncedAt: {
      name: 'synced_at',
      type: 'timestamp',
      nullable: false,
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
      name: 'UQ_calendar_event_email_nylas',
      columns: ['emailId', 'nylasEventId'],
      unique: true,
    },
    {
      name: 'idx_calendar_event_email_start',
      columns: ['emailId', 'startAt'],
    },
    {
      name: 'idx_calendar_event_range',
      columns: ['startAt', 'endAt'],
    },
  ],
});
