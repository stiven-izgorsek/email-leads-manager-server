import { AppDataSource } from '../src/config/database.js';

async function main() {
  try {
    await AppDataSource.initialize();
    await AppDataSource.undoLastMigration();
    console.log('Reverted last migration.');
  } catch (error) {
    console.error('Revert failed:', error);
    process.exitCode = 1;
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  }
}

void main();
