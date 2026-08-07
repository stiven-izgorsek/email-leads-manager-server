import 'dotenv/config';
import { connectDatabase, AppDataSource } from '../src/config/database.js';
import { Email } from '../src/entities/Email.js';
import { fetchFollowupCandidateClients } from '../src/services/followupService.js';

const mailboxAddress = process.argv[2] || 'alexzanderr50@gmail.com';

await connectDatabase();

const email = await AppDataSource.getRepository(Email).findOne({
  where: { address: mailboxAddress },
});
const pool = await fetchFollowupCandidateClients(email, 7, '2026-06-15', 500);
const ids = pool.map((c) => c.id);
if (!ids.length) {
  console.log('empty pool');
  process.exit(0);
}

const rows = await AppDataSource.query(
  `SELECT mal.client_id as "clientId",
          mal.nylas_message_id as "nylasMessageId"
   FROM marketing_assignment_lead mal
   INNER JOIN marketing_assignment ma ON ma.id = mal.assignment_id
   WHERE ma.email_id = $1
     AND mal.send_status = 'sent'
     AND mal.client_id = ANY($2::uuid[])`,
  [email.id, ids]
);

const withId = rows.filter((r) => String(r.nylasMessageId || '').trim()).length;
console.log(mailboxAddress, { pool: pool.length, marketingRows: rows.length, withNylasId: withId });
process.exit(0);
