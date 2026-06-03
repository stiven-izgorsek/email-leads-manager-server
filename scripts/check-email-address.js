import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const email = process.argv[2] || 'drakestamos511@gmail.com';
const client = new pg.Client({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'email_leads_manager',
});

await client.connect();
const rows = await client.query(
  `SELECT id, address, "deletedAt" FROM email WHERE LOWER(TRIM(address)) = LOWER(TRIM($1)) ORDER BY "deletedAt" NULLS FIRST`,
  [email]
);
console.log('all matching rows:', JSON.stringify(rows.rows, null, 2));
const active = await client.query(
  `SELECT id, address FROM email WHERE LOWER(TRIM(address)) = LOWER(TRIM($1)) AND "deletedAt" IS NULL`,
  [email]
);
console.log('active only:', JSON.stringify(active.rows, null, 2));
const indexes = await client.query(
  `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'email'`
);
console.log('indexes:', JSON.stringify(indexes.rows, null, 2));
await client.end();
