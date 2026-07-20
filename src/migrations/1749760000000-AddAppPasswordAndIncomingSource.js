/** @implements {import('typeorm').MigrationInterface} */
export class AddAppPasswordAndIncomingSource1749760000000 {
  name = 'AddAppPasswordAndIncomingSource1749760000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(
      `ALTER TABLE "email" ADD COLUMN IF NOT EXISTS "app_password" varchar NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "incoming_message" ADD COLUMN IF NOT EXISTS "source" varchar(32) NOT NULL DEFAULT 'nylas'`
    );
    await queryRunner.query(
      `ALTER TABLE "incoming_message" ADD COLUMN IF NOT EXISTS "body_html" text NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "incoming_message" ADD COLUMN IF NOT EXISTS "body_text" text NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "incoming_message" ADD COLUMN IF NOT EXISTS "to_email" varchar(255) NULL`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`ALTER TABLE "incoming_message" DROP COLUMN IF EXISTS "to_email"`);
    await queryRunner.query(`ALTER TABLE "incoming_message" DROP COLUMN IF EXISTS "body_text"`);
    await queryRunner.query(`ALTER TABLE "incoming_message" DROP COLUMN IF EXISTS "body_html"`);
    await queryRunner.query(`ALTER TABLE "incoming_message" DROP COLUMN IF EXISTS "source"`);
    await queryRunner.query(`ALTER TABLE "email" DROP COLUMN IF EXISTS "app_password"`);
  }
}
