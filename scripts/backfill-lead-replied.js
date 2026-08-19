import 'dotenv/config';
import { connectDatabase } from '../src/config/database.js';
import { backfillLeadRepliedFromIncomingMessages } from '../src/services/leadReplyStatusService.js';

await connectDatabase();

const result = await backfillLeadRepliedFromIncomingMessages();
console.log('Backfill complete:', result);

process.exit(0);
