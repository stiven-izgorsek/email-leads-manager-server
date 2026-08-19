/** @implements {import('typeorm').MigrationInterface} */
export class AddCalendarSlackNotification1749850000000 {
  name = 'AddCalendarSlackNotification1749850000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "calendar_slack_notification" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "event_key" varchar(500) NOT NULL,
        "occurrence_start" TIMESTAMP NOT NULL,
        "title" varchar(1000) NULL,
        "mailbox_email" varchar(255) NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_calendar_slack_notification_event_occurrence"
      ON "calendar_slack_notification" ("event_key", "occurrence_start")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_calendar_slack_notification_occurrence"
      ON "calendar_slack_notification" ("occurrence_start")
    `);
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`DROP TABLE IF EXISTS "calendar_slack_notification"`);
  }
}
