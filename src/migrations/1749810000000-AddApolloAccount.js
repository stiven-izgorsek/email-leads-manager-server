/** @implements {import('typeorm').MigrationInterface} */
export class AddApolloAccount1749810000000 {
  name = 'AddApolloAccount1749810000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "apollo_account" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "email" varchar(255) NOT NULL,
        "password" varchar(1000) NULL,
        "api_key" varchar(1000) NOT NULL,
        "label" varchar(255) NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP NULL
      )
    `);
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`DROP TABLE IF EXISTS "apollo_account"`);
  }
}
