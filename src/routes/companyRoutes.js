import express from 'express';
import {
  getCompanies,
  exportCompaniesCsv,
  getCompany,
  createCompany,
  updateCompany,
  deleteCompany,
  bulkUpdateCompanyStatus,
  bulkSoftDeleteCompanies,
} from '../controllers/companyController.js';
import {
  apolloSearch,
  apolloExtractCsv,
  apolloExtractDb,
  listCompanySavedSearches,
  createCompanySavedSearch,
  deleteCompanySavedSearch,
} from '../controllers/companyApolloController.js';
import { postResolveContactUrls } from '../controllers/companyContactResolveController.js';

const router = express.Router();

router.get('/', getCompanies);
router.get('/export/csv', exportCompaniesCsv);
router.get('/saved-searches', listCompanySavedSearches);
router.post('/saved-searches', createCompanySavedSearch);
router.delete('/saved-searches/:savedSearchId', deleteCompanySavedSearch);

router.post('/apollo/search', apolloSearch);
router.post('/apollo/extract/csv', apolloExtractCsv);
router.post('/apollo/extract/db', apolloExtractDb);

router.post('/resolve-contact-urls', postResolveContactUrls);

router.post('/bulk/status', bulkUpdateCompanyStatus);
router.post('/bulk/delete', bulkSoftDeleteCompanies);

router.get('/:id', getCompany);
router.post('/', createCompany);
router.put('/:id', updateCompany);
router.delete('/:id', deleteCompany);

export default router;
