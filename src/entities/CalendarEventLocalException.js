import { EntitySchema } from 'typeorm';

export class CalendarEventLocalException {
  constructor(
    id,
    masterEventId,
    originalStartAt,
    isCancelled,
    title,
    description,
    location,
    startAt,
    endAt,
    createdAt,
    updatedAt
  ) {
    this.id = id;
    this.masterEventId = masterEventId;
    this.originalStartAt = originalStartAt;
    this.isCancelled = isCancelled;
    this.title = title;
    this.description = description;
    this.location = location;
    this.startAt = startAt;
    this.endAt = endAt;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
}

export const CalendarEventLocalExceptionSchema = new EntitySchema({
  name: 'CalendarEventLocalException',
  tableName: 'calendar_event_local_exception',
  target: CalendarEventLocalException,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    masterEventId: {
      name: 'master_event_id',
      type: 'uuid',
      nullable: false,
    },
    originalStartAt: {
      name: 'original_start_at',
      type: 'timestamp',
      nullable: false,
    },
    isCancelled: {
      name: 'is_cancelled',
      type: 'boolean',
      default: true,
    },
    title: {
      type: 'varchar',
      length: 1000,
      nullable: true,
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
      nullable: true,
    },
    endAt: {
      name: 'end_at',
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
      name: 'UQ_calendar_event_local_exception_master_orig',
      columns: ['masterEventId', 'originalStartAt'],
      unique: true,
    },
    {
      name: 'idx_calendar_event_local_exception_master',
      columns: ['masterEventId'],
    },
  ],
});
