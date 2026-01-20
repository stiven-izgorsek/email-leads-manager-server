import { EntitySchema } from 'typeorm';

export class LeadFilter {
  constructor(id, industries, locations, tool, rating, createdAt) {
    this.id = id;
    this.industries = industries;
    this.locations = locations;
    this.tool = tool;
    this.rating = rating;
    this.createdAt = createdAt;
  }
}

export const LeadFilterSchema = new EntitySchema({
  name: 'LeadFilter',
  target: LeadFilter,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    industries: {
      type: 'simple-array',
      nullable: true,
    },
    locations: {
      type: 'simple-array',
      nullable: true,
    },
    tool: {
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    rating: {
      type: 'int',
      nullable: true,
    },
    createdAt: {
      type: 'timestamp',
      createDate: true,
    },
  },
});
