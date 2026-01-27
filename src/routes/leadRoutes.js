import express from 'express';
import multer from 'multer';
import path from 'path';
import os from 'os';
import { getLeads, createLead, uploadLeads, bulkDeleteLeads, bulkUpdateLeads, getUncontactedLeads, getLeadFilters, markClientAsSent, markClientAsFollowedUp, checkLeadsStatus, getDashboardKPIs, resetLeadsStatus } from '../controllers/leadController.js';
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
router.get('/filters', getLeadFilters);
router.get('/dashboard-kpis', getDashboardKPIs);
router.post('/', createLead);
router.post('/upload', upload.single('file'), uploadLeads);
router.post('/bulk-delete', bulkDeleteLeads);
router.post('/bulk-update', bulkUpdateLeads);
router.post('/check-status', checkLeadsStatus);
router.post('/reset-status', resetLeadsStatus);
router.put('/:clientId/mark-sent', markClientAsSent);
router.post('/mark-followed-up', markClientAsFollowedUp);

export default router;

