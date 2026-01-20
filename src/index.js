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
// TODO: Migrate these routes to TypeORM
// import subjectTemplateRoutes from './routes/subjectTemplateRoutes.js';
// import messageTemplateRoutes from './routes/messageTemplateRoutes.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
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
// TODO: Re-enable after migrating to TypeORM
// app.use('/api/subject-templates', subjectTemplateRoutes);
// app.use('/api/message-templates', messageTemplateRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
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

