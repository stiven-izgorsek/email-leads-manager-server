import { EntitySchema } from 'typeorm';

export class Template {
  constructor(id, content, type, tech, industries, createdAt, updatedAt, deletedAt) {
    this.id = id;
    this.content = content;
    this.type = type;
    this.tech = tech;
    this.industries = industries;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
    this.deletedAt = deletedAt;
  }
}

export const TemplateSchema = new EntitySchema({
  name: 'Template',
  target: Template,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    content: {
      type: 'text',
      nullable: false,
    },
    type: {
      type: 'varchar',
      length: 50,
      nullable: false,
    },
    tech: {
      type: 'simple-array',
      nullable: true,
    },
    industries: {
      type: 'simple-array',
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
