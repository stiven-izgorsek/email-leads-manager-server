/** @implements {import('typeorm').MigrationInterface} */
export class AddClientApolloEmailStatus1749820000000 {
  name = 'AddClientApolloEmailStatus1749820000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(
      `ALTER TABLE "client" ADD COLUMN IF NOT EXISTS "apollo_email_status" varchar(50) NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "client" ADD COLUMN IF NOT EXISTS "apollo_suggested_email" varchar(255) NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "client" ADD COLUMN IF NOT EXISTS "apollo_email_checked_at" TIMESTAMP NULL`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(
      `ALTER TABLE "client" DROP COLUMN IF EXISTS "apollo_email_checked_at"`
    );
    await queryRunner.query(
      `ALTER TABLE "client" DROP COLUMN IF EXISTS "apollo_suggested_email"`
    );
    await queryRunner.query(
      `ALTER TABLE "client" DROP COLUMN IF EXISTS "apollo_email_status"`
    );
  }
}
