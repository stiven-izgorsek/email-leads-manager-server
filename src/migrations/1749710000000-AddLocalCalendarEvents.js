/** @implements {import('typeorm').MigrationInterface} */
export class AddLocalCalendarEvents1749710000000 {
  name = 'AddLocalCalendarEvents1749710000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "calendar_event_local" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "email_id" uuid NOT NULL,
        "mailbox_email" varchar(255) NOT NULL,
        "title" varchar(1000) NOT NULL DEFAULT '(no title)',
        "description" text NULL,
        "location" varchar(1000) NULL,
        "start_at" TIMESTAMP NOT NULL,
        "end_at" TIMESTAMP NOT NULL,
        "all_day" boolean NOT NULL DEFAULT false,
        "recurrence_frequency" varchar(32) NULL,
        "recurrence_interval" integer NOT NULL DEFAULT 1,
        "recurrence_end_at" TIMESTAMP NULL,
        "deleted_at" TIMESTAMP NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_calendar_event_local_email_start" ON "calendar_event_local" ("email_id", "start_at")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_calendar_event_local_range" ON "calendar_event_local" ("start_at", "end_at")`
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "calendar_event_local_exception" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "master_event_id" uuid NOT NULL,
        "original_start_at" TIMESTAMP NOT NULL,
        "is_cancelled" boolean NOT NULL DEFAULT true,
        "title" varchar(1000) NULL,
        "description" text NULL,
        "location" varchar(1000) NULL,
        "start_at" TIMESTAMP NULL,
        "end_at" TIMESTAMP NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_calendar_event_local_exception_master_orig" UNIQUE ("master_event_id", "original_start_at"),
        CONSTRAINT "FK_calendar_event_local_exception_master"
          FOREIGN KEY ("master_event_id") REFERENCES "calendar_event_local"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_calendar_event_local_exception_master" ON "calendar_event_local_exception" ("master_event_id")`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`DROP TABLE IF EXISTS "calendar_event_local_exception"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "calendar_event_local"`);
  }
}
