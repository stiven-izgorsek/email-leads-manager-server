import express from 'express';
import { listCalendarEvents } from '../controllers/calendarController.js';

const router = express.Router();

router.get('/events', listCalendarEvents);

export default router;
