/** @implements {import('typeorm').MigrationInterface} */
export class AddEmailFirstLastName1749660000000 {
  name = 'AddEmailFirstLastName1749660000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(
      `ALTER TABLE "email" ADD COLUMN IF NOT EXISTS "first_name" varchar(255) NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "email" ADD COLUMN IF NOT EXISTS "last_name" varchar(255) NULL`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`ALTER TABLE "email" DROP COLUMN IF EXISTS "last_name"`);
    await queryRunner.query(`ALTER TABLE "email" DROP COLUMN IF EXISTS "first_name"`);
  }
}
