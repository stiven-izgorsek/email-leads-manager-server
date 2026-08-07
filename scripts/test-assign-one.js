import 'dotenv/config';
import { connectDatabase, AppDataSource } from '../src/config/database.js';
import { assignFollowupsToEmail } from '../src/services/followupService.js';
import { Email } from '../src/entities/Email.js';

const date = process.argv[2] || '2026-06-18';
const mailbox = process.argv[3] || 'alexzanderr50@gmail.com';
const count = parseInt(process.argv[4] || '3', 10);

await connectDatabase();

const fa = await AppDataSource.query(
  `SELECT COUNT(DISTINCT fa.id)::int as assignments,
          COUNT(fal.id) FILTER (WHERE fal.send_status = 'pending')::int as pending
   FROM followup_assignment fa
   LEFT JOIN followup_assignment_lead fal ON fal.assignment_id = fa.id
   WHERE fa.assignment_date = $1`,
  [date]
);
console.log('existing', date, fa[0]);

const email = await AppDataSource.getRepository(Email).findOne({ where: { address: mailbox } });
if (!email) {
  console.log('mailbox not found');
  process.exit(1);
}

const t0 = Date.now();
const r = await assignFollowupsToEmail(email.id, count, date, 7);
console.log('result', r, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
