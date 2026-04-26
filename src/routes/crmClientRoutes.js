import express from 'express';
import {
  listCrmClients,
  getCrmClient,
  createCrmClient,
  updateCrmClient,
  deleteCrmClient,
  getFollowUpsToday,
  getCrmClientStatuses,
} from '../controllers/crmClientController.js';

const router = express.Router();

router.get('/statuses', getCrmClientStatuses);
router.get('/follow-ups/today', getFollowUpsToday);

router.get('/', listCrmClients);
router.post('/', createCrmClient);
router.get('/:id', getCrmClient);
router.put('/:id', updateCrmClient);
router.delete('/:id', deleteCrmClient);

export default router;
