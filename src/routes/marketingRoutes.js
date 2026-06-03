import express from 'express';
import {
  assignMarketingLeads,
  assignMarketingLeadsAll,
  getAssignmentLeadsHandler,
  getMarketingDashboardHandler,
  releaseStuckMarketingRunsHandler,
  setMarketingEnabledHandler,
  startMarketingForAll,
  startMarketingForEmail,
  unassignMarketingLeadHandler,
  unassignAllPendingMarketingLeadsHandler,
  resetDailySentCountHandler,
} from '../controllers/marketingController.js';

const router = express.Router();

router.get('/dashboard', getMarketingDashboardHandler);
router.get('/assignments/:emailId/leads', getAssignmentLeadsHandler);
router.patch('/emails/:emailId/enabled', setMarketingEnabledHandler);
router.delete('/assignments/leads/:assignmentLeadId', unassignMarketingLeadHandler);
router.post('/unassign-all-pending', unassignAllPendingMarketingLeadsHandler);
router.post('/assign', assignMarketingLeads);
router.post('/assign-all', assignMarketingLeadsAll);
router.post('/start/:emailId', startMarketingForEmail);
router.post('/start-all', startMarketingForAll);
router.post('/reset-daily-sent', resetDailySentCountHandler);
router.post('/release-stuck-runs', releaseStuckMarketingRunsHandler);

export default router;
