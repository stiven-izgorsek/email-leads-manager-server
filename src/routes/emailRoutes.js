import express from 'express';
import multer from 'multer';
import path from 'path';
import os from 'os';
import { getEmails, createEmail, bulkDeleteEmails, bulkUpdateEmails, uploadEmails } from '../controllers/emailController.js';
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
router.post('/', createEmail);
router.post('/upload', upload.single('file'), uploadEmails);
router.post('/bulk-delete', bulkDeleteEmails);
router.post('/bulk-update', bulkUpdateEmails);

export default router;

