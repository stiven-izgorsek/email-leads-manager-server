import express from 'express';
import { listCalendarEvents, syncCalendarEvents } from '../controllers/calendarController.js';

const router = express.Router();

router.get('/events', listCalendarEvents);
router.post('/sync', syncCalendarEvents);

export default router;
