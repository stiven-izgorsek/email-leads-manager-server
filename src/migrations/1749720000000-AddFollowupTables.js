/** @implements {import('typeorm').MigrationInterface} */
export class AddFollowupTables1749720000000 {
  name = 'AddFollowupTables1749720000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "followup_assignment" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "email_id" uuid NOT NULL,
        "assignment_date" date NOT NULL,
        "days_before" int NOT NULL DEFAULT 7,
        "target_count" int NOT NULL DEFAULT 0,
        "status" varchar(32) NOT NULL DEFAULT 'assigned',
        "running" boolean NOT NULL DEFAULT false,
        "last_error" text NULL,
        "daily_limit_sent_baseline" int NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_followup_assignment_email_date" UNIQUE ("email_id", "assignment_date")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "followup_assignment_lead" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "assignment_id" uuid NOT NULL REFERENCES "followup_assignment"("id") ON DELETE CASCADE,
        "client_id" uuid NOT NULL,
        "send_status" varchar(32) NOT NULL DEFAULT 'pending',
        "reply_to_message_id" varchar(255) NULL,
        "original_subject" varchar(1000) NULL,
        "subject" varchar(1000) NULL,
        "body" text NULL,
        "error_message" text NULL,
        "nylas_message_id" varchar(255) NULL,
        "sent_at" TIMESTAMP NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_followup_assignment_lead_assignment" ON "followup_assignment_lead" ("assignment_id")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_followup_assignment_lead_client" ON "followup_assignment_lead" ("client_id")`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`DROP TABLE IF EXISTS "followup_assignment_lead"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "followup_assignment"`);
  }
}
