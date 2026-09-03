import 'dotenv/config';
import { connectDatabase } from '../src/config/database.js';
import { backfillClientLastInboundMessageType } from '../src/services/leadReplyStatusService.js';

await connectDatabase();

const result = await backfillClientLastInboundMessageType();
console.log('OOO reclaim backfill complete:', result);

process.exit(0);
