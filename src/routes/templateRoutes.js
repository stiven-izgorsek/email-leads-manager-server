import express from 'express';
import { 
  getSubjectTemplates, 
  getMessageTemplates, 
  createSubjectTemplate, 
  createMessageTemplate,
  generateMessageTemplates,
  updateMessageTemplate,
  composeEmailFromTemplates,
  composeAiEmail,
  renderTemplateContentHttp,
} from '../controllers/templateController.js';

const router = express.Router();

// Subject templates endpoints
router.get('/subject-templates', getSubjectTemplates);
router.post('/subject-templates', createSubjectTemplate);

// Message templates endpoints
router.get('/message-templates', getMessageTemplates);
router.post('/message-templates', createMessageTemplate);
router.post('/message-templates/generate', generateMessageTemplates);
router.put('/message-templates/:id', updateMessageTemplate);

// Compose email (backend selects templates + renders {{...}} placeholders)
router.post('/compose-email', composeEmailFromTemplates);
router.post('/compose-ai-email', composeAiEmail);
router.post('/render-template-content', renderTemplateContentHttp);

export default router;
