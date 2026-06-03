import { EntitySchema } from 'typeorm';

export class FollowupAssignment {
  constructor(
    id,
    emailId,
    assignmentDate,
    daysBefore,
    targetCount,
    status,
    running,
    lastError,
    dailyLimitSentBaseline,
    createdAt,
    updatedAt
  ) {
    this.id = id;
    this.emailId = emailId;
    this.assignmentDate = assignmentDate;
    this.daysBefore = daysBefore;
    this.targetCount = targetCount;
    this.status = status;
    this.running = running;
    this.lastError = lastError;
    this.dailyLimitSentBaseline = dailyLimitSentBaseline ?? 0;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
}

export const FollowupAssignmentSchema = new EntitySchema({
  name: 'FollowupAssignment',
  tableName: 'followup_assignment',
  target: FollowupAssignment,
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
    assignmentDate: {
      name: 'assignment_date',
      type: 'date',
      nullable: false,
    },
    daysBefore: {
      name: 'days_before',
      type: 'int',
      default: 7,
    },
    targetCount: {
      name: 'target_count',
      type: 'int',
      default: 0,
    },
    status: {
      type: 'varchar',
      length: 32,
      default: 'assigned',
    },
    running: {
      type: 'boolean',
      default: false,
    },
    lastError: {
      name: 'last_error',
      type: 'text',
      nullable: true,
    },
    dailyLimitSentBaseline: {
      name: 'daily_limit_sent_baseline',
      type: 'int',
      default: 0,
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
  relations: {
    email: {
      type: 'many-to-one',
      target: 'Email',
      joinColumn: { name: 'email_id', referencedColumnName: 'id' },
    },
    leads: {
      type: 'one-to-many',
      target: 'FollowupAssignmentLead',
      inverseSide: 'assignment',
    },
  },
  indices: [
    {
      name: 'idx_followup_assignment_email_date',
      columns: ['emailId', 'assignmentDate'],
      unique: true,
    },
  ],
});
