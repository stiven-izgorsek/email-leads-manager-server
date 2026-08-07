import { EntitySchema } from 'typeorm';

export class PortfolioTag {}

/** parentId is a plain column (no self-FK) so rows can be bulk-deleted per portfolio. */
export const PortfolioTagSchema = new EntitySchema({
  name: 'PortfolioTag',
  tableName: 'portfolio_tag',
  target: PortfolioTag,
  columns: {
    id: {
      type: 'uuid',
      primary: true,
      generated: 'uuid',
    },
    parentId: {
      type: 'uuid',
      nullable: true,
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
