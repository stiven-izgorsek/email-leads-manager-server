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
  getIncomingMessageContent,
  getIncomingUnreadCount,
  markAllIncomingAsRead,
  listLatestUnreadIncoming,
  deleteIncomingMessage,
  replyToIncomingMessage,
  listIncomingMessageReplies,
} from '../controllers/incomingMessageController.js';

const router = express.Router();

router.get('/incoming-messages', listIncomingMessages);
router.get('/incoming-messages/unread-count', getIncomingUnreadCount);
router.get('/incoming-messages/unread-latest', listLatestUnreadIncoming);
router.post('/incoming-messages/mark-all-read', markAllIncomingAsRead);
router.delete('/incoming-messages/:id', deleteIncomingMessage);
router.get('/incoming-messages/counts', listIncomingMessageTypeCounts);
router.post('/incoming-messages/analyze-period', analyzeIncomingMessagesPeriod);
router.get('/incoming-messages/:id/content', getIncomingMessageContent);
router.get('/incoming-messages/:id/replies', listIncomingMessageReplies);
router.post('/incoming-messages/:id/reply', replyToIncomingMessage);

router.get('/message-type-rules', listMessageTypeRules);
router.post('/message-type-rules', createMessageTypeRule);
router.patch('/message-type-rules/rename-type', renameMessageTypeForRules);
router.put('/message-type-rules/:id', updateMessageTypeRule);
router.delete('/message-type-rules/:id', deleteMessageTypeRule);

router.post('/message-types/classify-preview', classifyMessagePreview);

export default router;

