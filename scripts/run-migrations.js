import { AppDataSource } from '../src/config/database.js';

async function main() {
  try {
    await AppDataSource.initialize();
    const executed = await AppDataSource.runMigrations();
    if (executed.length === 0) {
      console.log('No pending migrations.');
    } else {
      for (const migration of executed) {
        console.log(`Ran: ${migration.name}`);
      }
    }
  } catch (error) {
    console.error('Migration failed:', error);
    process.exitCode = 1;
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  }
}

void main();
