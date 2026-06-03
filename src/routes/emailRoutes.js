import express from 'express';
import multer from 'multer';
import path from 'path';
import os from 'os';
import { getEmails, getEmailById, getEmailDetail, createEmail, updateEmail, bulkDeleteEmails, bulkUpdateEmails, uploadEmails, getNylasIntegrationStatus } from '../controllers/emailController.js';
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

router.get('/', getEmails);
router.get('/nylas-integration-status', getNylasIntegrationStatus);
router.get('/:id/detail', getEmailDetail);
router.get('/:id', getEmailById);
router.post('/', createEmail);
router.post('/upload', upload.single('file'), uploadEmails);
router.post('/bulk-delete', bulkDeleteEmails);
router.post('/bulk-update', bulkUpdateEmails);
router.put('/:id', updateEmail);

export default router;

