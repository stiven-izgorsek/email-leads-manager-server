/** @implements {import('typeorm').MigrationInterface} */
export class AddMarketingDomainBlockAlert1749840000000 {
  name = 'AddMarketingDomainBlockAlert1749840000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketing_domain_block_alert" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "email_id" uuid NOT NULL,
        "email_address" varchar(320) NOT NULL,
        "incoming_message_id" uuid NULL,
        "external_message_id" varchar(500) NULL,
        "subject" varchar(1000) NULL,
        "snippet" text NULL,
        "status" varchar(32) NOT NULL DEFAULT 'pending',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "acknowledged_at" TIMESTAMP NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_marketing_domain_block_alert_status"
      ON "marketing_domain_block_alert" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_marketing_domain_block_alert_email"
      ON "marketing_domain_block_alert" ("email_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_marketing_domain_block_alert_external"
      ON "marketing_domain_block_alert" ("email_address", "external_message_id")
      WHERE "external_message_id" IS NOT NULL
    `);
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`DROP TABLE IF EXISTS "marketing_domain_block_alert"`);
  }
}
