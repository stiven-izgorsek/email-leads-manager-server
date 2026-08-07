import express from 'express';
import {
  assignMarketingLeads,
  assignMarketingLeadsAll,
  getAssignmentLeadsHandler,
  getMarketingDashboardHandler,
  releaseStuckMarketingRunsHandler,
  setMarketingEnabledHandler,
  setMarketingAssignDefaultHandler,
  startMarketingForAll,
  startMarketingForEmail,
  stopMarketingForEmailHandler,
  unassignMarketingLeadHandler,
  unassignAllPendingMarketingLeadsHandler,
  resetDailySentCountHandler,
  listDomainBlockAlertsHandler,
  dismissDomainBlockAlertHandler,
  confirmDomainBlockAlertHandler,
} from '../controllers/marketingController.js';

const router = express.Router();

router.get('/dashboard', getMarketingDashboardHandler);
router.get('/assignments/:emailId/leads', getAssignmentLeadsHandler);
router.get('/domain-block-alerts', listDomainBlockAlertsHandler);
router.patch('/emails/:emailId/enabled', setMarketingEnabledHandler);
router.patch('/emails/:emailId/assign-default', setMarketingAssignDefaultHandler);
router.delete('/assignments/leads/:assignmentLeadId', unassignMarketingLeadHandler);
router.post('/unassign-all-pending', unassignAllPendingMarketingLeadsHandler);
router.post('/assign', assignMarketingLeads);
router.post('/assign-all', assignMarketingLeadsAll);
router.post('/start/:emailId', startMarketingForEmail);
router.post('/stop/:emailId', stopMarketingForEmailHandler);
router.post('/start-all', startMarketingForAll);
router.post('/reset-daily-sent', resetDailySentCountHandler);
router.post('/release-stuck-runs', releaseStuckMarketingRunsHandler);
router.post('/domain-block-alerts/:id/dismiss', dismissDomainBlockAlertHandler);
router.post('/domain-block-alerts/:id/confirm-stop', confirmDomainBlockAlertHandler);

export default router;
