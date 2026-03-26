import { EntitySchema } from 'typeorm';

export class Company {}

export const COMPANY_STATUSES = ['new', 'used', 'pending', 'archived'];

export const CompanySchema = new EntitySchema({
  name: 'Company',
  tableName: 'companies',
  target: Company,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    name: {
      type: 'varchar',
      length: 500,
    },
    legalName: {
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    domain: {
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    apolloOrganizationId: {
      type: 'varchar',
      length: 100,
      nullable: true,
      unique: true,
    },
    websiteUrl: {
      type: 'varchar',
      length: 2000,
      nullable: true,
    },
    email: {
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    phone: {
      type: 'varchar',
      length: 100,
      nullable: true,
    },
    industry: {
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    employeeCount: {
      type: 'varchar',
      length: 100,
      nullable: true,
    },
    annualRevenue: {
      type: 'varchar',
      length: 200,
      nullable: true,
    },
    addressLine1: {
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    addressLine2: {
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    city: {
      type: 'varchar',
      length: 200,
      nullable: true,
    },
    stateRegion: {
      type: 'varchar',
      length: 200,
      nullable: true,
    },
    country: {
      type: 'varchar',
      length: 200,
      nullable: true,
    },
    postalCode: {
      type: 'varchar',
      length: 50,
      nullable: true,
    },
    linkedinUrl: {
      type: 'varchar',
      length: 2000,
      nullable: true,
    },
    twitterUrl: {
      type: 'varchar',
      length: 2000,
      nullable: true,
    },
    description: {
      type: 'text',
      nullable: true,
    },
    notes: {
      type: 'text',
      nullable: true,
    },
    status: {
      type: 'varchar',
      length: 50,
      default: 'new',
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
