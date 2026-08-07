import { AppDataSource } from '../src/config/database.js';
import { Client } from '../src/entities/Client.js';
import { fetchUncontactedVerifiedLeads } from '../src/services/leadFetchService.js';

const email = process.argv[2] || 'gerrit.bury@inform-datalab.com';

await AppDataSource.initialize();

const before = await AppDataSource.getRepository(Client)
  .createQueryBuilder('c')
  .where('LOWER(c.email) = LOWER(:email)', { email })
  .getOne();
console.log('Before:', before?.status);

const leads = await fetchUncontactedVerifiedLeads({ count: 1, verifiedOnly: true });
const hit = leads.find((l) => l.email?.toLowerCase() === email.toLowerCase());
console.log('Fetched count:', leads.length, 'includes gerrit:', !!hit);

const after = await AppDataSource.getRepository(Client)
  .createQueryBuilder('c')
  .where('LOWER(c.email) = LOWER(:email)', { email })
  .getOne();
console.log('After:', after?.status);

await AppDataSource.destroy();
