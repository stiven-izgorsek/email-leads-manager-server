/**
 * Adds Client.templateIndustry — forced cold-message template bucket (skips AI classify).
 */
export class AddClientTemplateIndustry1749780000000 {
  name = 'AddClientTemplateIndustry1749780000000';

  async up(queryRunner) {
    await queryRunner.query(`
      ALTER TABLE "client"
      ADD COLUMN IF NOT EXISTS "templateIndustry" character varying(100) NULL
    `);
  }

  async down(queryRunner) {
    await queryRunner.query(`
      ALTER TABLE "client"
      DROP COLUMN IF EXISTS "templateIndustry"
    `);
  }
}
