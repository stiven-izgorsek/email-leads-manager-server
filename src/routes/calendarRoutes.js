import express from 'express';
import {
  listCalendarEvents,
  syncCalendarEvents,
  createLocalEventHandler,
  updateLocalEventHandler,
  deleteLocalEventHandler,
  deleteCalendarEventHandler,
  cancelLocalOccurrenceHandler,
  notifyCalendarEventSlackHandler,
} from '../controllers/calendarController.js';

const router = express.Router();

router.get('/events', listCalendarEvents);
router.post('/sync', syncCalendarEvents);

router.post('/local-events', createLocalEventHandler);
router.patch('/local-events/:id', updateLocalEventHandler);
router.delete('/local-events/:id', deleteLocalEventHandler);
router.post('/local-events/:id/cancel-occurrence', cancelLocalOccurrenceHandler);

/** Soft-delete local or synced events (platform-only). */
router.delete('/events/:id', deleteCalendarEventHandler);
/** Immediately notify Slack for a synced meeting. */
router.post('/events/:id/notify-slack', notifyCalendarEventSlackHandler);

export default router;
