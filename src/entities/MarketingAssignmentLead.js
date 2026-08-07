import { EntitySchema } from 'typeorm';

export class MarketingAssignmentLead {
  constructor(
    id,
    assignmentId,
    clientId,
    sendStatus,
    subject,
    body,
    errorMessage,
    nylasMessageId,
    sentAt,
    createdAt,
    updatedAt
  ) {
    this.id = id;
    this.assignmentId = assignmentId;
    this.clientId = clientId;
    this.sendStatus = sendStatus;
    this.subject = subject;
    this.body = body;
    this.errorMessage = errorMessage;
    this.nylasMessageId = nylasMessageId;
    this.sentAt = sentAt;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
}

export const MarketingAssignmentLeadSchema = new EntitySchema({
  name: 'MarketingAssignmentLead',
  tableName: 'marketing_assignment_lead',
  target: MarketingAssignmentLead,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    assignmentId: {
      name: 'assignment_id',
      type: 'uuid',
      nullable: false,
    },
    clientId: {
      name: 'client_id',
      type: 'uuid',
      nullable: false,
    },
    sendStatus: {
      name: 'send_status',
      type: 'varchar',
      length: 32,
      default: 'pending',
    },
    subject: {
      type: 'varchar',
      length: 1000,
      nullable: true,
    },
    body: {
      type: 'text',
      nullable: true,
    },
    errorMessage: {
      name: 'error_message',
      type: 'text',
      nullable: true,
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
  relations: {
    assignment: {
      type: 'many-to-one',
      target: 'MarketingAssignment',
      joinColumn: { name: 'assignment_id', referencedColumnName: 'id' },
      onDelete: 'CASCADE',
    },
    client: {
      type: 'many-to-one',
      target: 'Client',
      joinColumn: { name: 'client_id', referencedColumnName: 'id' },
    },
  },
  indices: [
    {
      name: 'idx_marketing_assignment_lead_assignment',
      columns: ['assignmentId'],
    },
    {
      name: 'idx_marketing_assignment_lead_client',
      columns: ['clientId'],
    },
  ],
});
