import 'reflect-metadata';
import { DataSource } from 'typeorm';
import dotenv from 'dotenv';
import {
  UserSchema,
  AccountSchema,
  EmailSchema,
  ClientSchema,
  TemplateSchema,
  InterviewSchema,
  LeadFilterSchema,
  PortfolioSchema,
  PortfolioIndustrySchema,
  PortfolioWorkExperienceSchema,
  PortfolioTagSchema,
  NylasSlackNotificationSchema,
  IncomingMessageSchema,
  MessageTypeRuleSchema,
  CompanySchema,
  CompanySavedSearchSchema,
  CrmClientSchema,
} from '../entities/index.js';

dotenv.config();

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'email_leads_manager',
  synchronize: process.env.NODE_ENV !== 'production', // Auto-sync schema in development
  logging: false, // Disable query logging
  entities: [
    UserSchema,
    AccountSchema,
    EmailSchema,
    ClientSchema,
    TemplateSchema,
    InterviewSchema,
    LeadFilterSchema,
    PortfolioSchema,
    PortfolioIndustrySchema,
    PortfolioWorkExperienceSchema,
    PortfolioTagSchema,
    NylasSlackNotificationSchema,
    IncomingMessageSchema,
    MessageTypeRuleSchema,
    CompanySchema,
    CompanySavedSearchSchema,
    CrmClientSchema,
  ],
  migrations: ['src/migrations/**/*.js'],
  subscribers: ['src/subscribers/**/*.js'],
});

export async function connectDatabase() {
  try {
    await AppDataSource.initialize();
    console.log('PostgreSQL database connected successfully');
  } catch (error) {
    console.error('Database connection error:', error);
    process.exit(1);
  }
}
