/** @implements {import('typeorm').MigrationInterface} */
export class AddClientIsInCrmClient1749870000000 {
  name = 'AddClientIsInCrmClient1749870000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(
      `ALTER TABLE "client" ADD COLUMN IF NOT EXISTS "is_in_crm_client" boolean NOT NULL DEFAULT false`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_client_used_reclaimable"
       ON "client" ("lastSent" ASC NULLS LAST, "createdAt" DESC)
       WHERE "deletedAt" IS NULL
         AND LOWER(TRIM(COALESCE(status, ''))) = 'used'
         AND ("isReplied" = false OR "isReplied" IS NULL)
         AND ("is_in_crm_client" = false)
         AND "millionsStatus" IN ('good', 'risky')`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_client_is_in_crm_client"
       ON "client" ("is_in_crm_client")
       WHERE "deletedAt" IS NULL`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_client_is_in_crm_client"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_client_used_reclaimable"`);
    await queryRunner.query(`ALTER TABLE "client" DROP COLUMN IF EXISTS "is_in_crm_client"`);
  }
}
