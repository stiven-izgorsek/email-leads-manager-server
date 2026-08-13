import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import { connectDatabase } from './config/database.js';
import 'reflect-metadata';

// Import routes
import authRoutes from './routes/authRoutes.js';
import accountRoutes from './routes/accountRoutes.js';
import emailRoutes from './routes/emailRoutes.js';
import leadRoutes from './routes/leadRoutes.js';
import userRoutes from './routes/userRoutes.js';
import templateRoutes from './routes/templateRoutes.js';
import portfolioRoutes from './routes/portfolioRoutes.js';
import companyRoutes from './routes/companyRoutes.js';
import crmClientRoutes from './routes/crmClientRoutes.js';
import incomingMessageRoutes from './routes/incomingMessageRoutes.js';
import applicationRoutes from './routes/applicationRoutes.js';
import calendarRoutes from './routes/calendarRoutes.js';
import marketingRoutes from './routes/marketingRoutes.js';
import followupRoutes from './routes/followupRoutes.js';
import apolloAccountRoutes from './routes/apolloAccountRoutes.js';
import { startNylasUnreadPollingJob } from './services/nylasPollingService.js';
// import { startImapUnreadPollingJob } from './services/imapPollingService.js';
import { startCalendarSyncJob } from './services/calendarSyncJob.js';
import { releaseAllOrphanedMarketingRuns } from './services/marketingService.js';
import { releaseAllOrphanedFollowupRuns } from './services/followupService.js';
import { ensureDefaultHiddenSenderEntries } from './services/incomingSenderFilterService.js';
import { ensureEcomLuxuryOutreachTemplates } from './services/ecomLuxuryTemplateSeed.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors({
  origin: true, // Allow all origins
  credentials: true,
  exposedHeaders: [
    'X-Apollo-Total-Fetched',
    'X-Apollo-Total-After-Founded-Year',
    'X-Apollo-Min-Founded-Year',
  ],
}));

// JSON parser - handle errors in middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/emails', emailRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/users', userRoutes);
app.use('/api', templateRoutes);
app.use('/api/portfolios', portfolioRoutes);
app.use('/api/companies', companyRoutes);
app.use('/api/crm-clients', crmClientRoutes);
app.use('/api', incomingMessageRoutes);
app.use('/api', applicationRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/marketing', marketingRoutes);
app.use('/api/followup', followupRoutes);
app.use('/api/apollo-accounts', apolloAccountRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  // Handle JSON parsing errors
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      error: 'Invalid JSON in request body',
      message: err.message,
      hint: 'Ensure the request body is valid JSON and Content-Type header is set to application/json'
    });
  }
  
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
async function startServer() {
  try {
    await connectDatabase();
    await ensureDefaultHiddenSenderEntries();
    await ensureEcomLuxuryOutreachTemplates();
    const releasedMarketing = await releaseAllOrphanedMarketingRuns('server startup');
    if (releasedMarketing > 0) {
      console.log(
        `[marketing] Cleared ${releasedMarketing} orphaned "running" mailbox flag(s) from before restart — refresh Marketing page`
      );
    }
    const releasedFollowup = await releaseAllOrphanedFollowupRuns('server startup');
    if (releasedFollowup > 0) {
      console.log(
        `[followup] Cleared ${releasedFollowup} orphaned "running" mailbox flag(s) from before restart`
      );
    }
    startNylasUnreadPollingJob();
    // Disabled: Gmail IMAP app-password auth is failing across mailboxes
    // (AUTHENTICATIONFAILED / Invalid credentials). Re-enable after app passwords are refreshed.
    // startImapUnreadPollingJob();
    startCalendarSyncJob();
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

