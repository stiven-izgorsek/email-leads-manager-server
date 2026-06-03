/** @implements {import('typeorm').MigrationInterface} */
export class AddCalendarEventsTable1749690000000 {
  name = 'AddCalendarEventsTable1749690000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "calendar_event" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "email_id" uuid NOT NULL,
        "mailbox_email" varchar(255) NOT NULL,
        "grant_id" varchar(255) NOT NULL,
        "nylas_event_id" varchar(255) NOT NULL,
        "title" varchar(1000) NOT NULL DEFAULT '(no title)',
        "start_at" TIMESTAMP NOT NULL,
        "end_at" TIMESTAMP NOT NULL,
        "all_day" boolean NOT NULL DEFAULT false,
        "location" varchar(1000) NULL,
        "html_link" varchar(2000) NULL,
        "event_status" varchar(64) NULL,
        "organizer_name" varchar(255) NULL,
        "organizer_email" varchar(255) NULL,
        "participants_json" jsonb NULL,
        "synced_at" TIMESTAMP NOT NULL DEFAULT now(),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_calendar_event_email_nylas" UNIQUE ("email_id", "nylas_event_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_calendar_event_email_start" ON "calendar_event" ("email_id", "start_at")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_calendar_event_range" ON "calendar_event" ("start_at", "end_at")`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`DROP TABLE IF EXISTS "calendar_event"`);
  }
}
