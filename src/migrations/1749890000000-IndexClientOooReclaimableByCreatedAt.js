/** @implements {import('typeorm').MigrationInterface} */
export class IndexClientOooReclaimableByCreatedAt1749890000000 {
  name = 'IndexClientOooReclaimableByCreatedAt1749890000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_client_ooo_reclaimable"
       ON "client" ("createdAt" ASC)
       WHERE "deletedAt" IS NULL
         AND LOWER(TRIM(COALESCE(status, ''))) IN ('replied', 'sent', 'followedup')
         AND LOWER(TRIM(COALESCE(last_inbound_message_type, ''))) = 'ooo'
         AND ("is_in_crm_client" = false)
         AND "millionsStatus" IN ('good', 'risky')`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_client_ooo_reclaimable"`);
  }
}
