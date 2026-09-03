/** @implements {import('typeorm').MigrationInterface} */
export class AddClientLastInboundMessageType1749860000000 {
  name = 'AddClientLastInboundMessageType1749860000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(
      `ALTER TABLE "client" ADD COLUMN IF NOT EXISTS "last_inbound_message_type" varchar(50) NULL`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_client_last_inbound_message_type"
       ON "client" ("last_inbound_message_type")
       WHERE "deletedAt" IS NULL`
    );
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_client_last_inbound_message_type"`);
    await queryRunner.query(
      `ALTER TABLE "client" DROP COLUMN IF EXISTS "last_inbound_message_type"`
    );
  }
}
