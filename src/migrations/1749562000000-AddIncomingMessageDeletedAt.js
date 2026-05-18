/**
 * Adds soft-delete for incoming_message so dismissed rows stay in DB and
 * Nylas polling does not recreate the same (emailAddress, messageId).
 *
 * @typedef {import('typeorm').MigrationInterface} MigrationInterface
 * @typedef {import('typeorm').QueryRunner} QueryRunner
 */

/** @implements {MigrationInterface} */
export class AddIncomingMessageDeletedAt1749562000000 {
  name = 'AddIncomingMessageDeletedAt1749562000000';

  /** @param {QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(
      `ALTER TABLE "incoming_message" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP NULL`
    );
  }

  /** @param {QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`ALTER TABLE "incoming_message" DROP COLUMN IF EXISTS "deletedAt"`);
  }
}
