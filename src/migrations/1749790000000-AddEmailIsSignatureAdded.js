/** @implements {import('typeorm').MigrationInterface} */
export class AddEmailIsSignatureAdded1749790000000 {
  name = 'AddEmailIsSignatureAdded1749790000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(
      `ALTER TABLE "email" ADD COLUMN IF NOT EXISTS "is_signature_added" boolean NOT NULL DEFAULT false`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`ALTER TABLE "email" DROP COLUMN IF EXISTS "is_signature_added"`);
  }
}
