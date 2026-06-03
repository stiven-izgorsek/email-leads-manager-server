export class AddMarketingDailyLimitSentBaseline1749710000000 {
  name = 'AddMarketingDailyLimitSentBaseline1749710000000';

  async up(queryRunner) {
    await queryRunner.query(`
      ALTER TABLE "marketing_assignment"
      ADD COLUMN IF NOT EXISTS "daily_limit_sent_baseline" integer NOT NULL DEFAULT 0
    `);
  }

  async down(queryRunner) {
    await queryRunner.query(`
      ALTER TABLE "marketing_assignment"
      DROP COLUMN IF EXISTS "daily_limit_sent_baseline"
    `);
  }
}
