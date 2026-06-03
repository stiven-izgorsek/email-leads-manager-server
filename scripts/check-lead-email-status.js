import { AppDataSource } from '../src/config/database.js';
import { Client } from '../src/entities/Client.js';

const email = process.argv[2] || 'gerrit.bury@inform-datalab.com';

await AppDataSource.initialize();
const repo = AppDataSource.getRepository(Client);

const rows = await repo
  .createQueryBuilder('c')
  .where('LOWER(c.email) = LOWER(:email)', { email })
  .andWhere('c.deletedAt IS NULL')
  .getMany();

console.log(`Rows for ${email}:`, rows.length);
for (const r of rows) {
  console.log({ id: r.id, status: r.status, millionsStatus: r.millionsStatus, isSent: r.isSent });
}

const dupes = await repo.query(`
  SELECT LOWER(TRIM(email)) AS email, COUNT(*)::int AS cnt,
    array_agg(DISTINCT status) AS statuses
  FROM client
  WHERE "deletedAt" IS NULL AND email IS NOT NULL AND TRIM(email) <> ''
  GROUP BY LOWER(TRIM(email))
  HAVING COUNT(*) > 1
  ORDER BY cnt DESC
  LIMIT 10
`);
console.log('\nTop duplicate emails:', dupes);

await AppDataSource.destroy();
