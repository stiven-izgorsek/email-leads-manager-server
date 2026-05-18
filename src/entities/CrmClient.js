import { EntitySchema } from 'typeorm';

export const CRM_CLIENT_STATUSES = [
  'first_connected',
  'no_response',
  'in_discussion',
  'first_call_scheduled',
  'second_call_scheduled',
  'proposal_sent',
  'nda_signed',
  'contract_signed',
  'stay_connect',
  'on_hold',
  'failed',
];

export class CrmClient {
  constructor(
    id,
    leadId,
    email,
    firstName,
    lastName,
    country,
    companyName,
    jobTitle,
    linkedin,
    connectedAt,
    sentByAccount,
    chatHistory,
    note,
    rating,
    status,
    followUpAt,
    createdAt,
    updatedAt,
    deletedAt
  ) {
    this.id = id;
    this.leadId = leadId;
    this.email = email;
    this.firstName = firstName;
    this.lastName = lastName;
    this.country = country;
    this.companyName = companyName;
    this.jobTitle = jobTitle;
    this.linkedin = linkedin;
    this.connectedAt = connectedAt;
    this.sentByAccount = sentByAccount;
    this.chatHistory = chatHistory;
    this.note = note;
    this.rating = rating;
    this.status = status;
    this.followUpAt = followUpAt;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.deletedAt = deletedAt;
  }
}

export const CrmClientSchema = new EntitySchema({
  name: 'CrmClient',
  target: CrmClient,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    leadId: {
      type: 'uuid',
      nullable: true,
    },
    email: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    firstName: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    lastName: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    country: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    companyName: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    jobTitle: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    linkedin: {
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    connectedAt: {
      type: 'timestamp',
      nullable: true,
    },
    sentByAccount: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    chatHistory: {
      type: 'text',
      nullable: true,
    },
    note: {
      type: 'text',
      nullable: true,
    },
    rating: {
      type: 'smallint',
      nullable: true,
    },
    status: {
      type: 'varchar',
      length: 50,
      nullable: false,
      default: 'first_connected',
    },
    /** Ordered CRM tags; varchar `status` mirrors the first tag for sorting / legacy rows */
    statuses: {
      type: 'jsonb',
      nullable: true,
    },
    followUpAt: {
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
    deletedAt: {
      type: 'timestamp',
      nullable: true,
    },
  },
  indices: [
    { name: 'idx_crm_client_status', columns: ['status'] },
    { name: 'idx_crm_client_email', columns: ['email'] },
    { name: 'idx_crm_client_followup', columns: ['followUpAt'] },
    { name: 'idx_crm_client_lead', columns: ['leadId'] },
  ],
});
