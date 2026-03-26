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
import incomingMessageRoutes from './routes/incomingMessageRoutes.js';
import { startNylasUnreadPollingJob } from './services/nylasPollingService.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors({
  origin: true, // Allow all origins
  credentials: true,
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
app.use('/api', incomingMessageRoutes);

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
    startNylasUnreadPollingJob();
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

