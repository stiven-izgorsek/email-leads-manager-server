import express from 'express';
import {
  assignFollowupLeads,
  assignFollowupLeadsAll,
  getFollowupAssignmentLeadsHandler,
  getFollowupDashboardHandler,
  releaseStuckFollowupRunsHandler,
  resetFollowupDailySentHandler,
  setFollowupEnabledHandler,
  startFollowupForAll,
  startFollowupForEmail,
  stopAllFollowupRunsHandler,
  unassignAllPendingFollowupLeadsHandler,
  unassignFollowupLeadHandler,
} from '../controllers/followupController.js';

const router = express.Router();

router.get('/dashboard', getFollowupDashboardHandler);
router.get('/assignments/:emailId/leads', getFollowupAssignmentLeadsHandler);
router.patch('/emails/:emailId/enabled', setFollowupEnabledHandler);
router.delete('/assignments/leads/:assignmentLeadId', unassignFollowupLeadHandler);
router.post('/unassign-all-pending', unassignAllPendingFollowupLeadsHandler);
router.post('/assign', assignFollowupLeads);
router.post('/assign-all', assignFollowupLeadsAll);
router.post('/start/:emailId', startFollowupForEmail);
router.post('/start-all', startFollowupForAll);
router.post('/stop-all', stopAllFollowupRunsHandler);
router.post('/reset-daily-sent', resetFollowupDailySentHandler);
router.post('/release-stuck-runs', releaseStuckFollowupRunsHandler);

export default router;
