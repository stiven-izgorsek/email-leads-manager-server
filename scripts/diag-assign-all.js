import 'dotenv/config';
import { connectDatabase, AppDataSource } from '../src/config/database.js';
import { getFollowupDashboard, fetchFollowupCandidateClients, assignFollowupsToEmail } from '../src/services/followupService.js';
import { resolveOriginalOutboundForFollowup } from '../src/services/nylasOriginalMessageService.js';
import { Email } from '../src/entities/Email.js';

const date = process.argv[2] || '2026-06-15';
const days = parseInt(process.argv[3] || '7', 10);
const defaultCount = parseInt(process.argv[4] || '10', 10);
const dryRun = process.argv.includes('--dry');
const nylasSample = parseInt(process.argv.find((a) => a.startsWith('--nylas='))?.split('=')[1] || '2', 10);

await connectDatabase();

function resolveAssignCount(row, defaultCount) {
  const limit = row.followupDailyLimit ?? defaultCount;
  const pending = row.pendingCount || 0;
  const sent = row.effectiveSentCount || 0;
  const remaining = Math.max(0, limit - pending - sent);
  const cap = Math.max(1, Math.min(500, defaultCount));
  const dlr = row.dailyLimitRemaining;
  if (dlr != null) return Math.max(0, Math.min(cap, remaining, dlr));
  return Math.max(0, Math.min(cap, remaining));
}

const dashboard = await getFollowupDashboard(date);
const eligible = dashboard.rows.filter((r) => r.followupEnabled && r.canAssign);

console.log(`date=${date} days=${days} defaultCount=${defaultCount} eligible=${eligible.length}/${dashboard.rows.length}\n`);

const emailRepo = AppDataSource.getRepository(Email);
let summary = { zeroPool: 0, zeroThread: 0, hasAssignable: 0, limitZero: 0, alreadyFull: 0 };

for (const row of eligible) {
  const count = resolveAssignCount(row, defaultCount);
  const pool = await fetchFollowupCandidateClients(
    await emailRepo.findOne({ where: { id: row.emailId } }),
    days,
    date,
    500
  );

  let threadOk = 0;
  let threadFail = 0;
  if (pool.length && nylasSample > 0) {
    const email = await emailRepo.findOne({ where: { id: row.emailId } });
    for (const c of pool.slice(0, nylasSample)) {
      const orig = await resolveOriginalOutboundForFollowup({
        emailId: email.id,
        grantId: email.grantId,
        nylasKey: email.nylasKey,
        mailboxAddress: email.address,
        clientId: c.id,
        leadEmail: c.email,
        lastSent: c.lastSent,
      });
      if (orig?.messageId) threadOk++;
      else threadFail++;
    }
  }

  const status =
    count === 0
      ? row.pendingCount > 0
        ? 'AT_LIMIT'
        : 'COUNT_ZERO'
      : pool.length === 0
        ? 'NO_POOL'
        : threadFail > 0 && threadOk === 0
          ? 'NO_THREAD'
          : 'OK';

  if (count === 0) summary.limitZero++;
  else if (pool.length === 0) summary.zeroPool++;
  else if (threadFail > 0 && threadOk === 0 && nylasSample > 0) summary.zeroThread++;
  else summary.hasAssignable++;

  const short = row.address.split('@')[0].slice(0, 22).padEnd(23);
  console.log(
    `${short} limit=${String(row.followupDailyLimit).padStart(2)} rem=${String(row.dailyLimitRemaining).padStart(2)} assign=${String(count).padStart(2)} pool=${String(pool.length).padStart(4)} nylas=${threadOk}/${threadOk + threadFail} ${status}`
  );
}

console.log('\nSUMMARY', summary);

if (!dryRun && process.argv.includes('--assign-one')) {
  const target = eligible.find((r) => r.address.includes('alexzanderr50'));
  if (target) {
    const r = await assignFollowupsToEmail(target.emailId, 3, date, days);
    console.log('assign-one', target.address, r);
  }
}

process.exit(0);
