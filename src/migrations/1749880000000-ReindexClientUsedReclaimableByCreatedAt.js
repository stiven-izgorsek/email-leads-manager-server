/** @implements {import('typeorm').MigrationInterface} */
export class ReindexClientUsedReclaimableByCreatedAt1749880000000 {
  name = 'ReindexClientUsedReclaimableByCreatedAt1749880000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_client_used_reclaimable"`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_client_used_reclaimable"
       ON "client" ("createdAt" ASC)
       WHERE "deletedAt" IS NULL
         AND LOWER(TRIM(COALESCE(status, ''))) = 'used'
         AND ("isReplied" = false OR "isReplied" IS NULL)
         AND ("is_in_crm_client" = false)
         AND "millionsStatus" IN ('good', 'risky')`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_client_used_reclaimable"`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_client_used_reclaimable"
       ON "client" ("lastSent" ASC NULLS LAST, "createdAt" DESC)
       WHERE "deletedAt" IS NULL
         AND LOWER(TRIM(COALESCE(status, ''))) = 'used'
         AND ("isReplied" = false OR "isReplied" IS NULL)
         AND ("is_in_crm_client" = false)
         AND "millionsStatus" IN ('good', 'risky')`
    );
  }
}
