/** @implements {import('typeorm').MigrationInterface} */
export class AddEmailFollowupEnabled1749730000000 {
  name = 'AddEmailFollowupEnabled1749730000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(
      `ALTER TABLE "email" ADD COLUMN IF NOT EXISTS "followup_enabled" boolean NOT NULL DEFAULT true`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`ALTER TABLE "email" DROP COLUMN IF EXISTS "followup_enabled"`);
  }
}
