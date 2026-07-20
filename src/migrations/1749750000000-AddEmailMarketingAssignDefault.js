/** @implements {import('typeorm').MigrationInterface} */
export class AddEmailMarketingAssignDefault1749750000000 {
  name = 'AddEmailMarketingAssignDefault1749750000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(
      `ALTER TABLE "email" ADD COLUMN IF NOT EXISTS "marketing_assign_default" int NULL`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`ALTER TABLE "email" DROP COLUMN IF EXISTS "marketing_assign_default"`);
  }
}
