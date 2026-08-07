/** @implements {import('typeorm').MigrationInterface} */
export class AddCalendarEventSoftDeleteAndOptionalMailbox1749800000000 {
  name = 'AddCalendarEventSoftDeleteAndOptionalMailbox1749800000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(
      `ALTER TABLE "calendar_event" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "calendar_event_local" ALTER COLUMN "email_id" DROP NOT NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "calendar_event_local" ALTER COLUMN "mailbox_email" DROP NOT NULL`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(
      `ALTER TABLE "calendar_event" DROP COLUMN IF EXISTS "deleted_at"`
    );
    // Re-require mailbox only for rows that still have one
    await queryRunner.query(
      `UPDATE "calendar_event_local" SET "email_id" = '00000000-0000-0000-0000-000000000000' WHERE "email_id" IS NULL`
    );
    await queryRunner.query(
      `UPDATE "calendar_event_local" SET "mailbox_email" = '' WHERE "mailbox_email" IS NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "calendar_event_local" ALTER COLUMN "email_id" SET NOT NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "calendar_event_local" ALTER COLUMN "mailbox_email" SET NOT NULL`
    );
  }
}
