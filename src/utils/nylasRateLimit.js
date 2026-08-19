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

function parsePositiveIntEnv(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/** Default 5 attempts; override with NYLAS_HTTP_RETRY_ATTEMPTS. */
export function getNylasHttpRetryAttempts() {
  return Math.min(10, parsePositiveIntEnv('NYLAS_HTTP_RETRY_ATTEMPTS', 5));
}

/** Base backoff ms (doubles each attempt); override with NYLAS_HTTP_RETRY_BASE_MS. */
export function getNylasHttpRetryBaseMs() {
  const n = parseInt(process.env.NYLAS_HTTP_RETRY_BASE_MS || '', 10);
  return Number.isFinite(n) && n >= 100 ? Math.min(30_000, n) : 1000;
}

export function isRetryableNylasHttpStatus(status) {
  const s = Number(status) || 0;
  return s === 408 || s === 429 || s === 500 || s === 502 || s === 503 || s === 504;
}

/**
 * Permanent API errors that should never be retried.
 */
export function isPermanentNylasErrorMessage(messageOrBody) {
  const msg = String(messageOrBody || '').toLowerCase();
  if (!msg) return false;
  return /country, region, or territory not supported|invalid api key|token\.unauthorized|unauthorized_access|invalid.?grant|authentication failed|insufficient.?permission|forbidden|mailbox is missing/i.test(
    msg
  );
}

export function isRetryableNylasNetworkError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const cause = String(err?.cause?.message || err?.cause || '').toLowerCase();
  const combined = `${msg} ${cause}`;
  if (isPermanentNylasErrorMessage(combined)) return false;
  return (
    msg === 'fetch failed' ||
    /fetch failed|network|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|socket closed|und_err|timeout|timed out|temporarily unavailable|try again|connection reset|connection refused|networkerror|failed to fetch/i.test(
      combined
    )
  );
}

function backoffMsForAttempt(attempt, baseMs, response, responseText) {
  if (response?.status === 429) {
    return Math.min(Math.max(parseNylas429RetryDelayMs(response, responseText), baseMs), 60_000);
  }
  // 1s, 2s, 4s, 8s… capped at 30s
  return Math.min(baseMs * 2 ** Math.max(0, attempt - 1), 30_000);
}

/**
 * fetch() wrapper with retries for transient Nylas/network failures.
 * Does not throw on HTTP error statuses — caller checks `response.ok`.
 * Throws only after exhausting retries on network failures.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {{ attempts?: number, baseMs?: number, label?: string }} [options]
 * @returns {Promise<{ response: Response, text: string, attempt: number }>}
 */
export async function nylasFetchWithRetry(url, init = {}, options = {}) {
  const attempts = Math.max(1, options.attempts ?? getNylasHttpRetryAttempts());
  const baseMs = options.baseMs ?? getNylasHttpRetryBaseMs();
  const label = options.label || 'nylas';
  let lastNetworkError = null;
  let lastHttp = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      const text = await response.text().catch(() => '');

      if (response.ok) {
        return { response, text, attempt };
      }

      // Auth / permanent — fail immediately (still return so caller can format error).
      if (
        response.status === 401 ||
        response.status === 403 ||
        isPermanentNylasErrorMessage(text)
      ) {
        return { response, text, attempt };
      }

      const retryableStatus = isRetryableNylasHttpStatus(response.status);
      lastHttp = { response, text, attempt };

      if (retryableStatus && attempt < attempts) {
        const delay = backoffMsForAttempt(attempt, baseMs, response, text);
        console.warn(
          `[${label}] retry ${attempt}/${attempts} HTTP ${response.status} wait=${delay}ms`
        );
        await sleep(delay);
        continue;
      }

      return { response, text, attempt };
    } catch (err) {
      lastNetworkError = err;
      if (attempt < attempts && isRetryableNylasNetworkError(err)) {
        const delay = backoffMsForAttempt(attempt, baseMs, null, '');
        console.warn(
          `[${label}] retry ${attempt}/${attempts} network="${err?.message || err}" wait=${delay}ms`
        );
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }

  if (lastHttp) return lastHttp;
  throw lastNetworkError || new Error('Nylas request failed after retries');
}
