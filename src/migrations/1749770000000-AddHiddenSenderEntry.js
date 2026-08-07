/** @implements {import('typeorm').MigrationInterface} */
export class AddHiddenSenderEntry1749770000000 {
  name = 'AddHiddenSenderEntry1749770000000';

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async up(queryRunner) {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hidden_sender_entry" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "value" varchar(255) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_hidden_sender_entry_value" UNIQUE ("value")
      )
    `);

    const seeds = [
      '7card.co.jp',
      'mail.drivepilothub.com',
      'vehicleinsurancexpert.com',
      'machinelearntech.com',
      'lendinblue.com',
      'autoconvert360.com',
      'naadam.co',
      'vehicleproinsurance.com',
      'auto.autonewssite.com',
      'automatedfintech.com',
      'alerts.protegoinsure.com',
      'autob2btech.com',
      'autoleadverse.com',
      'autolendiq.com',
      'aibenefitsphere.com',
      'jackerwin.com',
      'mail.insuresmarttech.com',
      'alerts.insurextract.com',
      't.tradingcentury.com',
      'thinkcloud.balloonthought.com',
      'quantumautomationpro.com',
      'healthplusauto.com',
      'evonovatech.com',
      'news.healthchoicesales.com',
      'mail.idinspo.com',
      'autoinsurecore.com',
      'revcraftsman.com',
    ];

    for (const value of seeds) {
      await queryRunner.query(
        `INSERT INTO "hidden_sender_entry" ("value") VALUES ($1)
         ON CONFLICT ("value") DO NOTHING`,
        [value]
      );
    }
  }

  /** @param {import('typeorm').QueryRunner} queryRunner */
  async down(queryRunner) {
    await queryRunner.query(`DROP TABLE IF EXISTS "hidden_sender_entry"`);
  }
}
