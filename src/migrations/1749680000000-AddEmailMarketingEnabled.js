/** @implements {import('typeorm').MigrationInterface} */
export class AddEmailMarketingEnabled1749680000000 {
  name = 'AddEmailMarketingEnabled1749680000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(
      `ALTER TABLE "email" ADD COLUMN IF NOT EXISTS "marketing_enabled" boolean NOT NULL DEFAULT true`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`ALTER TABLE "email" DROP COLUMN IF EXISTS "marketing_enabled"`);
  }
}
