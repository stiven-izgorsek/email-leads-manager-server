import 'dotenv/config';
import { connectDatabase, AppDataSource } from '../src/config/database.js';
import { Email } from '../src/entities/Email.js';
import { fetchFollowupCandidateClients } from '../src/services/followupService.js';
import { resolveOriginalOutboundForFollowup } from '../src/services/nylasOriginalMessageService.js';
import { leadIsEligibleForFollowup } from '../src/services/followupReplyGuardService.js';

const mailboxAddress = process.argv[2] || 'devcastromatthew@gmail.com';
const sampleSize = parseInt(process.argv[3] || '8', 10);

await connectDatabase();

const email = await AppDataSource.getRepository(Email)
  .createQueryBuilder('e')
  .where('e.address = :a', { a: mailboxAddress })
  .getOne();
if (!email) {
  console.log('mailbox not found');
  process.exit(1);
}

const batch = await fetchFollowupCandidateClients(email, 7, '2026-06-15', sampleSize);
let thread = 0;
let noThread = 0;
let reply = 0;

for (const c of batch) {
  const orig = await resolveOriginalOutboundForFollowup({
    emailId: email.id,
    grantId: email.grantId,
    nylasKey: email.nylasKey,
    mailboxAddress: email.address,
    clientId: c.id,
    leadEmail: c.email,
    lastSent: c.lastSent,
  });
  if (!orig?.messageId) {
    noThread += 1;
    continue;
  }
  const elig = await leadIsEligibleForFollowup({
    mailboxAddress: email.address,
    leadEmail: c.email,
    lastSent: c.lastSent,
    grantId: email.grantId,
    nylasKey: email.nylasKey,
    originalMessageId: orig.messageId,
    checkNylas: true,
  });
  if (!elig.eligible) {
    reply += 1;
    continue;
  }
  thread += 1;
}

console.log(mailboxAddress, { pool: batch.length, thread, noThread, reply });
process.exit(0);
