/**
 * In-process coordination for background work (no Redis/RabbitMQ).
 * - Cap concurrent "heavy" jobs (CSV import, Millions, Apollo) so they don't stampede the DB/API
 * - Let pollers see when heavy work is active and back off slightly
 * - Yield to the event loop so HTTP stays responsive during long loops
 */

const DEFAULT_MAX_HEAVY = Math.max(
  1,
  Math.min(3, parseInt(process.env.BACKGROUND_MAX_HEAVY_JOBS || '1', 10) || 1)
);

/** @type {Map<string, { name: string, startedAt: number }>} */
const activeHeavy = new Map();
/** @type {Array<() => void>} */
const waitQueue = [];

let heavySeq = 0;

function wakeNextWaiter() {
  const next = waitQueue.shift();
  if (next) next();
}

export function getHeavyWorkSnapshot() {
  return {
    maxConcurrent: DEFAULT_MAX_HEAVY,
    active: [...activeHeavy.values()].map((j) => ({
      name: j.name,
      startedAt: new Date(j.startedAt).toISOString(),
      runningMs: Date.now() - j.startedAt,
    })),
    waiting: waitQueue.length,
  };
}

export function isHeavyWorkActive() {
  return activeHeavy.size > 0;
}

/**
 * Yield to the event loop (keeps Express responsive during long CPU/await loops).
 */
export function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Run a heavy background job with a concurrency cap.
 * Extra jobs wait (FIFO) instead of all hammering DB/APIs at once.
 * @param {string} name
 * @param {() => Promise<any>} fn
 */
export async function runHeavyWork(name, fn) {
  const label = String(name || 'heavy').trim() || 'heavy';

  while (activeHeavy.size >= DEFAULT_MAX_HEAVY) {
    await new Promise((resolve) => {
      waitQueue.push(resolve);
    });
  }

  const id = `${label}:${Date.now()}:${++heavySeq}`;
  activeHeavy.set(id, { name: label, startedAt: Date.now() });
  if (activeHeavy.size === 1 || waitQueue.length > 0) {
    console.log(
      `[background] start heavy="${label}" active=${activeHeavy.size}/${DEFAULT_MAX_HEAVY} waiting=${waitQueue.length}`
    );
  }

  try {
    return await fn();
  } finally {
    activeHeavy.delete(id);
    console.log(
      `[background] end heavy="${label}" active=${activeHeavy.size}/${DEFAULT_MAX_HEAVY} waiting=${waitQueue.length}`
    );
    wakeNextWaiter();
  }
}

/**
 * Extra stagger (ms) for pollers while heavy work is running.
 */
export function getPollBackoffMsWhenHeavy(baseStaggerMs = 0) {
  if (!isHeavyWorkActive()) return Math.max(0, baseStaggerMs || 0);
  const base = Math.max(0, baseStaggerMs || 0);
  return Math.max(base * 2, base + 800);
}
