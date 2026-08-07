import 'dotenv/config';
import { connectDatabase, AppDataSource } from '../src/config/database.js';
import { Client } from '../src/entities/Client.js';
import { buildUncontactedLeadsQuery } from '../src/services/leadFetchService.js';

const excludeClientIds = `bc8f3420-7f2d-46f2-88f6-a3be96b3c765,65af7fdc-9ba8-454e-a70c-e492bf47299f,647df4e5-292b-4f7f-ac1b-c38e9001f081,c3d70be5-2a07-4729-82be-f3a0bc6d5ffc,77123645-d728-4bb0-8d56-10a0ef6e1ec2,6446fb23-9237-4d28-a519-57ef4583edff,4911d92b-29ea-4be4-b52f-0042797ca82f,6f290a84-a050-4a4e-aae3-d68b3ceef41f,39e3e00b-1370-4071-9bf1-a787ecb07e53,9e690935-1816-4c12-a8ea-98bee27e229b`
  .split(',')
  .map((s) => s.trim());

await connectDatabase();
const clientRepo = AppDataSource.getRepository(Client);

const stats = await AppDataSource.query(`
  SELECT
    COUNT(*) FILTER (WHERE "deletedAt" IS NULL) as total,
    COUNT(*) FILTER (WHERE "deletedAt" IS NULL AND (LOWER(TRIM(status)) = 'new' OR status IS NULL)) as status_new,
    COUNT(*) FILTER (WHERE "deletedAt" IS NULL AND (LOWER(TRIM(status)) = 'new' OR status IS NULL) AND "millionsStatus" IN ('good','risky')) as new_good_risky,
    COUNT(*) FILTER (WHERE "deletedAt" IS NULL AND (LOWER(TRIM(status)) = 'new' OR status IS NULL) AND "millionsStatus" IN ('good','risky') AND ("isSent" IS NOT TRUE)) as new_good_not_sent,
    COUNT(*) FILTER (WHERE "deletedAt" IS NULL AND (LOWER(TRIM(status)) = 'new' OR status IS NULL) AND "millionsStatus" = 'good') as new_good,
    COUNT(*) FILTER (WHERE "deletedAt" IS NULL AND (LOWER(TRIM(status)) = 'new' OR status IS NULL) AND "millionsStatus" = 'bad') as new_bad
  FROM client
`);
console.log('stats', stats[0]);

const qb = buildUncontactedLeadsQuery(clientRepo, { verifiedOnly: true, excludeClientIds });
const sql = qb.getQueryAndParameters();
const poolCount = await qb.getCount();
console.log('uncontacted pool count', poolCount);

const sample = await buildUncontactedLeadsQuery(clientRepo, { verifiedOnly: true, excludeClientIds })
  .take(5)
  .getMany();
console.log(
  'sample',
  sample.map((c) => ({ id: c.id, email: c.email, status: c.status, millions: c.millionsStatus }))
);

// Check how many blocked by ready-email duplicate
const blockedByReadyDup = await AppDataSource.query(`
  SELECT COUNT(*)::int as c FROM client c
  WHERE c."deletedAt" IS NULL
    AND (c."isSent" IS NOT TRUE)
    AND (LOWER(TRIM(c.status)) = 'new' OR c.status IS NULL)
    AND c."millionsStatus" IN ('good','risky')
    AND EXISTS (
      SELECT 1 FROM client claimed
      WHERE claimed."deletedAt" IS NULL
        AND LOWER(TRIM(claimed.email)) = LOWER(TRIM(c.email))
        AND LOWER(TRIM(claimed.status)) = 'ready'
        AND claimed.id <> c.id
    )
`);
console.log('new good/risky blocked by duplicate-ready-email', blockedByReadyDup[0].c);

const blockedByPendingMal = await AppDataSource.query(`
  SELECT COUNT(*)::int as c FROM client c
  WHERE c."deletedAt" IS NULL
    AND (c."isSent" IS NOT TRUE)
    AND (LOWER(TRIM(c.status)) = 'new' OR c.status IS NULL)
    AND c."millionsStatus" IN ('good','risky')
    AND EXISTS (
      SELECT 1 FROM marketing_assignment_lead mal
      WHERE mal.client_id = c.id AND mal.send_status = 'pending'
    )
`);
console.log('new good/risky blocked by pending marketing', blockedByPendingMal[0].c);

const readyCount = await AppDataSource.query(`
  SELECT COUNT(*)::int as c FROM client WHERE "deletedAt" IS NULL AND LOWER(TRIM(status)) = 'ready'
`);
console.log('ready status count', readyCount[0].c);

const pendingMalStatus = await AppDataSource.query(`
  SELECT LOWER(TRIM(COALESCE(c.status, ''))) as status, COUNT(*)::int as c
  FROM marketing_assignment_lead mal
  JOIN client c ON c.id = mal.client_id
  WHERE mal.send_status = 'pending' AND c."deletedAt" IS NULL
  GROUP BY 1 ORDER BY c DESC
`);
console.log('pending marketing by client status', pendingMalStatus);

process.exit(0);
