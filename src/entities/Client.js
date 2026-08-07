import { EntitySchema } from 'typeorm';

export class Client {
  constructor(id, firstName, lastName, linkedin, companyName, companyUrl, companyLinkedin, industries, templateIndustry, status, sentBy, lastSent, tech, companyLocation, email, emailStatus, location, contactedBy, jobTitle, photoUrl, employees, isSent, isReplied, isFollowup, note, leadFilterId, millionsStatus, apolloEmailStatus, apolloSuggestedEmail, apolloEmailCheckedAt, createdAt, updatedAt, deletedAt) {
    this.id = id;
    this.firstName = firstName;
    this.lastName = lastName;
    this.linkedin = linkedin;
    this.companyName = companyName;
    this.companyUrl = companyUrl;
    this.companyLinkedin = companyLinkedin;
    this.industries = industries;
    this.templateIndustry = templateIndustry;
    this.status = status;
    this.sentBy = sentBy;
    this.lastSent = lastSent;
    this.tech = tech;
    this.companyLocation = companyLocation;
    this.email = email;
    this.emailStatus = emailStatus;
    this.location = location;
    this.contactedBy = contactedBy;
    this.jobTitle = jobTitle;
    this.photoUrl = photoUrl;
    this.employees = employees;
    this.isSent = isSent;
    this.isReplied = isReplied;
    this.isFollowup = isFollowup;
    this.note = note;
    this.leadFilterId = leadFilterId;
    this.millionsStatus = millionsStatus;
    this.apolloEmailStatus = apolloEmailStatus;
    this.apolloSuggestedEmail = apolloSuggestedEmail;
    this.apolloEmailCheckedAt = apolloEmailCheckedAt;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.deletedAt = deletedAt;
  }
}

export const ClientSchema = new EntitySchema({
  name: 'Client',
  target: Client,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
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
    linkedin: {
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    companyName: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    companyUrl: {
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    /** Company LinkedIn page URL — used to keep one lead per company on upload. */
    companyLinkedin: {
      name: 'company_linkedin',
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    industries: {
      type: 'simple-array',
      nullable: true,
    },
    /** Forced cold-message template industry (skips AI website classify when set). */
    templateIndustry: {
      type: 'varchar',
      length: 100,
      nullable: true,
    },
    status: {
      type: 'varchar',
      length: 50,
      nullable: false,
      default: 'new',
    },
    sentBy: {
      type: 'simple-array',
      nullable: true,
    },
    lastSent: {
      type: 'timestamp',
      nullable: true,
    },
    tech: {
      type: 'simple-array',
      nullable: true,
    },
    companyLocation: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    email: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    emailStatus: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    location: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    contactedBy: {
      type: 'simple-array',
      nullable: true,
    },
    jobTitle: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    photoUrl: {
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    employees: {
      type: 'int',
      nullable: true,
    },
    isSent: {
      type: 'boolean',
      nullable: true,
      default: false,
    },
    isReplied: {
      type: 'boolean',
      nullable: true,
      default: false,
    },
    isFollowup: {
      type: 'boolean',
      nullable: true,
      default: false,
    },
    note: {
      type: 'text',
      nullable: true,
    },
    leadFilterId: {
      type: 'uuid',
      nullable: true,
    },
    millionsStatus: {
      type: 'varchar',
      length: 50,
      nullable: true,
    },
    /**
     * Result of Apollo LinkedIn email enrichment:
     * updated | no_email | email_conflict | error
     */
    apolloEmailStatus: {
      name: 'apollo_email_status',
      type: 'varchar',
      length: 50,
      nullable: true,
    },
    /** Email Apollo returned when it conflicted with another lead. */
    apolloSuggestedEmail: {
      name: 'apollo_suggested_email',
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    apolloEmailCheckedAt: {
      name: 'apollo_email_checked_at',
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
});
