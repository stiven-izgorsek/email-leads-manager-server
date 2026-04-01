import express from 'express';
import { 
  getSubjectTemplates, 
  getMessageTemplates, 
  createSubjectTemplate, 
  createMessageTemplate,
  composeEmailFromTemplates,
  composeAiEmail
} from '../controllers/templateController.js';

const router = express.Router();

// Subject templates endpoints
router.get('/subject-templates', getSubjectTemplates);
router.post('/subject-templates', createSubjectTemplate);

// Message templates endpoints
router.get('/message-templates', getMessageTemplates);
router.post('/message-templates', createMessageTemplate);

// Compose email (backend selects templates + renders {{...}} placeholders)
router.post('/compose-email', composeEmailFromTemplates);
router.post('/compose-ai-email', composeAiEmail);

export default router;
