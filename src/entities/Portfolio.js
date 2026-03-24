import { EntitySchema } from 'typeorm';

export class Portfolio {}

export const PortfolioSchema = new EntitySchema({
  name: 'Portfolio',
  tableName: 'portfolio',
  target: Portfolio,
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
    websiteUrl: {
      type: 'varchar',
      length: 2000,
    },
    credentialUser: {
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    credentialPass: {
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    clientName: {
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    clientEmail: {
      type: 'varchar',
      length: 500,
      nullable: true,
    },
    script: {
      type: 'text',
      default: '',
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
    industries: {
      type: 'one-to-many',
      target: 'PortfolioIndustry',
      inverseSide: 'portfolio',
      cascade: true,
    },
    workExperience: {
      type: 'one-to-many',
      target: 'PortfolioWorkExperience',
      inverseSide: 'portfolio',
      cascade: true,
    },
    tags: {
      type: 'one-to-many',
      target: 'PortfolioTag',
      inverseSide: 'portfolio',
      cascade: true,
    },
  },
});
