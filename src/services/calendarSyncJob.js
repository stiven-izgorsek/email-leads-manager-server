import { runScheduledCalendarSync } from './calendarSyncService.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

const intervalMs = Math.max(
  5 * 60 * 1000,
  parseInt(process.env.CALENDAR_SYNC_INTERVAL_MS || '', 10) || ONE_HOUR_MS
);

let timer = null;
let running = false;

async function tick() {
  if (running) {
    console.log('[calendar-sync] Skipping tick — previous sync still running');
    return;
  }
  running = true;
  try {
    await runScheduledCalendarSync();
  } catch (err) {
    console.error('[calendar-sync] Scheduled sync failed:', err);
  } finally {
    running = false;
  }
}

export function startCalendarSyncJob({ initialDelayMs = 0 } = {}) {
  if (timer) return;
  const kickoff = () => {
    console.log(`[calendar-sync] Job scheduled every ${Math.round(intervalMs / 60000)} minute(s)`);
    void tick();
    timer = setInterval(() => void tick(), intervalMs);
  };
  if (initialDelayMs > 0) {
    console.log(
      `[calendar-sync] First sync in ${Math.round(initialDelayMs / 1000)}s (staggered startup)`
    );
    setTimeout(kickoff, initialDelayMs);
  } else {
    kickoff();
  }
}
