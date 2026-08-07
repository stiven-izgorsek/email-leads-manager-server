import 'dotenv/config';
import { connectDatabase, AppDataSource } from '../src/config/database.js';
import { fetchFollowupCandidateClients } from '../src/services/followupService.js';

await connectDatabase();

const stats = await AppDataSource.query(`
  SELECT 
    COUNT(*) FILTER (WHERE "isSent" = true AND "lastSent" IS NOT NULL) as sent_with_date,
    COUNT(*) FILTER (WHERE "isSent" = true AND "lastSent" IS NOT NULL AND ("sentBy" IS NULL OR TRIM("sentBy") = '')) as sent_no_sentby,
    COUNT(*) FILTER (WHERE "isSent" = true AND "lastSent" IS NOT NULL AND "sentBy" IS NOT NULL AND TRIM("sentBy") <> '') as sent_has_sentby
  FROM client WHERE "deletedAt" IS NULL
`);
console.log('client stats', stats[0]);

const emailRow = await AppDataSource.query(`
  SELECT id, address, grant_id as "grantId", nylas_key as "nylasKey"
  FROM email WHERE "deletedAt" IS NULL AND grant_id IS NOT NULL AND TRIM(grant_id) <> ''
  ORDER BY address LIMIT 1
`);
const e = emailRow[0];
console.log('mailbox', e.address);

const days = 7;
const cutoff = new Date();
cutoff.setHours(23, 59, 59, 999);
cutoff.setDate(cutoff.getDate() - days);

const withSentBy = await AppDataSource.query(
  `SELECT COUNT(*)::int as c FROM client WHERE "deletedAt" IS NULL AND "isSent" = true
   AND ("isFollowup" IS NOT TRUE) AND ("isReplied" IS NOT TRUE) AND "lastSent" IS NOT NULL AND "lastSent" <= $1
   AND LOWER(COALESCE("sentBy", '')) LIKE $2`,
  [cutoff, `%${e.address.toLowerCase()}%`]
);
console.log('with sentBy match', withSentBy[0].c);

const candidates = await fetchFollowupCandidateClients(e, days, '2026-05-27', 100);
console.log('after incoming filter', candidates.length);

process.exit(0);
