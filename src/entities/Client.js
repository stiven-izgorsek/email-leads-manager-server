import { EntitySchema } from 'typeorm';

export class Client {
  constructor(id, firstName, lastName, linkedin, companyName, companyUrl, industries, status, sentBy, lastSent, tech, companyLocation, email, emailStatus, location, contactedBy, jobTitle, photoUrl, employees, isSent, isReplied, note, createdAt, updatedAt, deletedAt) {
    this.id = id;
    this.firstName = firstName;
    this.lastName = lastName;
    this.linkedin = linkedin;
    this.companyName = companyName;
    this.companyUrl = companyUrl;
    this.industries = industries;
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
    this.note = note;
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
    industries: {
      type: 'simple-array',
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
    note: {
      type: 'text',
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
