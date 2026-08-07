import { EntitySchema } from 'typeorm';

export class FollowupAssignmentLead {
  constructor(
    id,
    assignmentId,
    clientId,
    sendStatus,
    replyToMessageId,
    originalSubject,
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
    this.replyToMessageId = replyToMessageId;
    this.originalSubject = originalSubject;
    this.subject = subject;
    this.body = body;
    this.errorMessage = errorMessage;
    this.nylasMessageId = nylasMessageId;
    this.sentAt = sentAt;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }
}

export const FollowupAssignmentLeadSchema = new EntitySchema({
  name: 'FollowupAssignmentLead',
  tableName: 'followup_assignment_lead',
  target: FollowupAssignmentLead,
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
    replyToMessageId: {
      name: 'reply_to_message_id',
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    originalSubject: {
      name: 'original_subject',
      type: 'varchar',
      length: 1000,
      nullable: true,
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
      target: 'FollowupAssignment',
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
      name: 'idx_followup_assignment_lead_assignment',
      columns: ['assignmentId'],
    },
    {
      name: 'idx_followup_assignment_lead_client',
      columns: ['clientId'],
    },
  ],
});
