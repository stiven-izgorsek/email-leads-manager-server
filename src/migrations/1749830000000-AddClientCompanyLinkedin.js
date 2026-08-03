/** @implements {import('typeorm').MigrationInterface} */
export class AddClientCompanyLinkedin1749830000000 {
  name = 'AddClientCompanyLinkedin1749830000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(
      `ALTER TABLE "client" ADD COLUMN IF NOT EXISTS "company_linkedin" varchar(500) NULL`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(
      `ALTER TABLE "client" DROP COLUMN IF EXISTS "company_linkedin"`
    );
  }
}
