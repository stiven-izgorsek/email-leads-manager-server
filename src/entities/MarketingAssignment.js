import { EntitySchema } from 'typeorm';

export class MarketingAssignment {
  constructor(
    id,
    emailId,
    assignmentDate,
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
    this.targetCount = targetCount;
    this.status = status;
    this.running = running;
    this.lastError = lastError;
    this.dailyLimitSentBaseline = dailyLimitSentBaseline ?? 0;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
}

export const MarketingAssignmentSchema = new EntitySchema({
  name: 'MarketingAssignment',
  tableName: 'marketing_assignment',
  target: MarketingAssignment,
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
      target: 'MarketingAssignmentLead',
      inverseSide: 'assignment',
    },
  },
  indices: [
    {
      name: 'idx_marketing_assignment_email_date',
      columns: ['emailId', 'assignmentDate'],
      unique: true,
    },
  ],
});
