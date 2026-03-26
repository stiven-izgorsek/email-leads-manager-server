import express from 'express';
import { 
  getSubjectTemplates, 
  getMessageTemplates, 
  createSubjectTemplate, 
  createMessageTemplate,
  composeEmailFromTemplates
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

export default router;
