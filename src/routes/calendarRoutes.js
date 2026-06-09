import express from 'express';
import {
  listCalendarEvents,
  syncCalendarEvents,
  createLocalEventHandler,
  updateLocalEventHandler,
  deleteLocalEventHandler,
  cancelLocalOccurrenceHandler,
} from '../controllers/calendarController.js';

const router = express.Router();

router.get('/events', listCalendarEvents);
router.post('/sync', syncCalendarEvents);

router.post('/local-events', createLocalEventHandler);
router.patch('/local-events/:id', updateLocalEventHandler);
router.delete('/local-events/:id', deleteLocalEventHandler);
router.post('/local-events/:id/cancel-occurrence', cancelLocalOccurrenceHandler);

export default router;
