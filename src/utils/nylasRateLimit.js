/**
 * Nylas returns 429 with guidance to use list limit <= 20 (see https://nyl.as/429-tmr).
 * Use this for messages/events list endpoints that paginate.
 */
export const NYLAS_LIST_PAGE_LIMIT = 20;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {Response} response
 * @param {string} responseText
 * @returns {number} delay in ms (capped)
 */
export function parseNylas429RetryDelayMs(response, responseText) {
  const ra = response?.headers?.get?.('retry-after');
  if (ra) {
    const sec = parseInt(String(ra).trim(), 10);
    if (Number.isFinite(sec) && sec > 0) return Math.min(sec * 1000, 300000);
  }
  const text = String(responseText || '');
  const m = text.match(/Retry after\s+([0-9TZ.:\-+]+Z?)/i);
  if (m) {
    const t = Date.parse(m[1]);
    if (!Number.isNaN(t)) return Math.min(Math.max(0, t - Date.now()) + 250, 300000);
  }
  return 5000;
}
