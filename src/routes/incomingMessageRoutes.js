import express from 'express';
import {
  listIncomingMessages,
  listIncomingMessageTypeCounts,
  listMessageTypeRules,
  createMessageTypeRule,
  updateMessageTypeRule,
  deleteMessageTypeRule,
  renameMessageTypeForRules,
  analyzeIncomingMessagesPeriod,
  classifyMessagePreview,
} from '../controllers/incomingMessageController.js';

const router = express.Router();

router.get('/incoming-messages', listIncomingMessages);
router.get('/incoming-messages/counts', listIncomingMessageTypeCounts);
router.post('/incoming-messages/analyze-period', analyzeIncomingMessagesPeriod);

router.get('/message-type-rules', listMessageTypeRules);
router.post('/message-type-rules', createMessageTypeRule);
router.patch('/message-type-rules/rename-type', renameMessageTypeForRules);
router.put('/message-type-rules/:id', updateMessageTypeRule);
router.delete('/message-type-rules/:id', deleteMessageTypeRule);

router.post('/message-types/classify-preview', classifyMessagePreview);

export default router;

