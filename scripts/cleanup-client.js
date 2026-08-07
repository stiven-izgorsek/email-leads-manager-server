import 'reflect-metadata';
import { AppDataSource, connectDatabase } from '../src/config/database.js';
import { Client } from '../src/entities/Client.js';

async function cleanupClientTable() {
  try {
    // Connect to database
    await connectDatabase();
    
    const clientRepository = AppDataSource.getRepository(Client);
    
    // Option 1: Delete all records (including soft-deleted)
    const result = await clientRepository
      .createQueryBuilder()
      .delete()
      .from(Client)
      .execute();
    
    console.log(`✅ Deleted ${result.affected || 0} records from Client table`);
    
    // Option 2: If you want to delete only non-deleted records (keep soft-deleted):
    // const result = await clientRepository
    //   .createQueryBuilder()
    //   .delete()
    //   .from(Client)
    //   .where('deletedAt IS NULL')
    //   .execute();
    
    // Option 3: If you want to hard delete all including soft-deleted:
    // const result = await clientRepository
    //   .createQueryBuilder()
    //   .delete()
    //   .from(Client)
    //   .where('1 = 1')
    //   .execute();
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error cleaning up Client table:', error);
    process.exit(1);
  }
}

cleanupClientTable();
