/**
 * Stores manual CRM replies sent to incoming messages (via Nylas in-thread reply).
 *
 * @typedef {import('typeorm').MigrationInterface} MigrationInterface
 * @typedef {import('typeorm').QueryRunner} QueryRunner
 */

/** @implements {MigrationInterface} */
export class AddIncomingMessageReply1749740000000 {
  name = 'AddIncomingMessageReply1749740000000';

  /** @param {QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "incoming_message_reply" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "incoming_message_id" uuid NOT NULL,
        "email_address" varchar(255) NOT NULL,
        "to_email" varchar(255) NOT NULL,
        "to_name" varchar(255) NULL,
        "subject" varchar(1000) NULL,
        "body" text NOT NULL,
        "nylas_message_id" varchar(255) NULL,
        "sent_at" TIMESTAMP NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_incoming_message_reply" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_incoming_message_reply_incoming"
      ON "incoming_message_reply" ("incoming_message_id")
    `);
  }

  /** @param {QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_incoming_message_reply_incoming"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "incoming_message_reply"`);
  }
}
