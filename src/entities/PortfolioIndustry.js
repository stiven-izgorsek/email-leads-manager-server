import { EntitySchema } from 'typeorm';

export class PortfolioIndustry {}

export const PortfolioIndustrySchema = new EntitySchema({
  name: 'PortfolioIndustry',
  tableName: 'portfolio_industry',
  target: PortfolioIndustry,
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
