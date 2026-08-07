import express from 'express';
import {
  listApolloAccounts,
  createApolloAccount,
  updateApolloAccount,
  deleteApolloAccount,
} from '../controllers/apolloAccountController.js';

const router = express.Router();

router.get('/', listApolloAccounts);
router.post('/', createApolloAccount);
router.put('/:id', updateApolloAccount);
router.delete('/:id', deleteApolloAccount);

export default router;
