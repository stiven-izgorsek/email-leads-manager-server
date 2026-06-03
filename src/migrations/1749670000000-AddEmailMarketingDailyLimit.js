/** @implements {import('typeorm').MigrationInterface} */
export class AddEmailMarketingDailyLimit1749670000000 {
  name = 'AddEmailMarketingDailyLimit1749670000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(
      `ALTER TABLE "email" ADD COLUMN IF NOT EXISTS "marketing_daily_limit" int NULL`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`ALTER TABLE "email" DROP COLUMN IF EXISTS "marketing_daily_limit"`);
  }
}
