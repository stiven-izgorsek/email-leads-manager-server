import express from 'express';
import { postCoverLetter, postAnswerQuestion, postMessageReply } from '../controllers/applicationController.js';

const router = express.Router();

router.post('/application/cover-letter', postCoverLetter);
router.post('/application/answer', postAnswerQuestion);
router.post('/application/message-reply', postMessageReply);

export default router;
