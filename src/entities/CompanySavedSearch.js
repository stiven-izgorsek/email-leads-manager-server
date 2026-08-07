import { EntitySchema } from 'typeorm';

export class CompanySavedSearch {}

export const CompanySavedSearchSchema = new EntitySchema({
  name: 'CompanySavedSearch',
  tableName: 'company_saved_searches',
  target: CompanySavedSearch,
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
    filtersJson: {
      type: 'text',
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
});
