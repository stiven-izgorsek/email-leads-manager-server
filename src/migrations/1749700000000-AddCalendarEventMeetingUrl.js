/** @implements {import('typeorm').MigrationInterface} */
export class AddCalendarEventMeetingUrl1749700000000 {
  name = 'AddCalendarEventMeetingUrl1749700000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(
      `ALTER TABLE "calendar_event" ADD COLUMN IF NOT EXISTS "meeting_url" varchar(2000) NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "calendar_event" ADD COLUMN IF NOT EXISTS "meeting_provider" varchar(64) NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "calendar_event" ADD COLUMN IF NOT EXISTS "description" text NULL`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`ALTER TABLE "calendar_event" DROP COLUMN IF EXISTS "description"`);
    await queryRunner.query(`ALTER TABLE "calendar_event" DROP COLUMN IF EXISTS "meeting_provider"`);
    await queryRunner.query(`ALTER TABLE "calendar_event" DROP COLUMN IF EXISTS "meeting_url"`);
  }
}
