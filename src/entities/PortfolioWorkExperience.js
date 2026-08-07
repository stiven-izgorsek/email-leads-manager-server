import { EntitySchema } from 'typeorm';

export class PortfolioWorkExperience {}

export const PortfolioWorkExperienceSchema = new EntitySchema({
  name: 'PortfolioWorkExperience',
  tableName: 'portfolio_work_experience',
  target: PortfolioWorkExperience,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    category: {
      type: 'varchar',
      length: 255,
    },
    bullets: {
      type: 'text',
      default: '[]',
    },
  },
  relations: {
    portfolio: {
      type: 'many-to-one',
      target: 'Portfolio',
      joinColumn: { name: 'portfolioId' },
      onDelete: 'CASCADE',
    },
  },
});
