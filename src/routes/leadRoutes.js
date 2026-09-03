import express from 'express';
import multer from 'multer';
import path from 'path';
import os from 'os';
import { getLeads, createLead, uploadLeads, getLeadUploadStatus, bulkDeleteLeads, bulkUpdateLeads, getUncontactedLeads, getAssignablePoolStats, getLeadFilters, markClientAsSent, markClientAsFollowedUp, checkLeadsStatus, getDashboardKPIs, getDashboardAnalytics, resetLeadsStatus, getEmailsSentInDateRange, bulkVerifyEmails, bulkVerifyAllNew, getNewLeadsVerificationCount, getVerificationStatus, downloadNewLeadsCsv, getFollowupCandidates, getApolloMissingEmailCount, fetchApolloEmails, getApolloFetchStatus, getLeadById, updateLead, deleteLead, getLeadHistory } from '../controllers/leadController.js';
// import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, os.tmpdir());
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

// router.use(authenticateToken); // Uncomment to enable authentication

router.get('/', getLeads);
router.get('/uncontacted', getUncontactedLeads);
router.get('/assignable-pool', getAssignablePoolStats);
router.get('/filters', getLeadFilters);
router.get('/dashboard-kpis', getDashboardKPIs);
router.get('/dashboard-analytics', getDashboardAnalytics);
router.get('/emails-date-range', getEmailsSentInDateRange);
router.get('/followup-candidates', getFollowupCandidates);
router.post('/', createLead);
router.post('/upload', upload.single('file'), uploadLeads);
router.get('/upload-status/:jobId', getLeadUploadStatus);
router.post('/bulk-delete', bulkDeleteLeads);
router.post('/bulk-update', bulkUpdateLeads);
router.post('/check-status', checkLeadsStatus);
router.post('/reset-status', resetLeadsStatus);
router.post('/bulk-verify-emails', bulkVerifyEmails);
router.post('/bulk-verify-all-new', bulkVerifyAllNew);
router.get('/new-leads-verification-count', getNewLeadsVerificationCount);
router.get('/download-new-csv', downloadNewLeadsCsv);
router.get('/verification-status/:jobId', getVerificationStatus);
router.get('/apollo-missing-email-count', getApolloMissingEmailCount);
router.post('/fetch-apollo-emails', fetchApolloEmails);
router.get('/apollo-fetch-status/:jobId', getApolloFetchStatus);
router.get('/:id/history', getLeadHistory);
router.get('/:id', getLeadById);
router.put('/:id', updateLead);
router.delete('/:id', deleteLead);
router.put('/:clientId/mark-sent', markClientAsSent);
router.post('/mark-followed-up', markClientAsFollowedUp);

export default router;

