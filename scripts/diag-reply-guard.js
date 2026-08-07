import 'dotenv/config';
import { connectDatabase, AppDataSource } from '../src/config/database.js';
import { Email } from '../src/entities/Email.js';
import { fetchFollowupCandidateClients } from '../src/services/followupService.js';
import { hasStoredInboundReplySince } from '../src/services/followupReplyGuardService.js';

const mailboxAddress = process.argv[2] || 'devcastromatthew@gmail.com';

await connectDatabase();

const email = await AppDataSource.getRepository(Email)
  .createQueryBuilder('e')
  .where('e.address = :a', { a: mailboxAddress })
  .getOne();
if (!email) {
  console.log('mailbox not found');
  process.exit(1);
}

const batch = await fetchFollowupCandidateClients(email, 7, '2026-06-15', 50);
console.log('candidates', batch.length);

for (const c of batch.slice(0, 5)) {
  const s = await hasStoredInboundReplySince({
    mailboxAddress: email.address,
    leadEmail: c.email,
    lastSent: c.lastSent,
  });
  if (!s) {
    console.log('OK lead', c.email);
    continue;
  }
  const rows = await AppDataSource.manager.query(
    `SELECT "messageType", "fromEmail", "subject", "receivedAt"
     FROM incoming_message im
     WHERE im."emailAddress" = $1 AND im."deletedAt" IS NULL
       AND im."messageType" <> 'ignored_sender'
       AND im."messageType" <> 'hide_sender'
       AND COALESCE(im."receivedAt", im."createdAt") > $2
     ORDER BY COALESCE(im."receivedAt", im."createdAt") ASC LIMIT 8`,
    [email.address, c.lastSent]
  );
  console.log('SKIP lead', c.email, 'lastSent', c.lastSent);
  for (const r of rows) {
    const leadInFrom = String(r.fromEmail || '').toLowerCase().includes(String(c.email || '').toLowerCase());
    const leadInSub = String(r.subject || '').toLowerCase().includes(String(c.email || '').toLowerCase());
    console.log(' ', r.messageType, r.fromEmail?.slice(0, 40), leadInFrom ? 'LEAD-FROM' : '', leadInSub ? 'LEAD-SUB' : '');
  }
}

process.exit(0);
