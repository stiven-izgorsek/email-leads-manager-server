/**
 * Millions Email Verification Service
 * API Documentation: https://api.millionverifier.com/api/v3/
 *
 * Concurrency knobs (env):
 * - MILLIONS_VERIFY_CONCURRENCY — parallel single-email calls (default 10, max 50)
 * - MILLIONS_VERIFY_DELAY_MS — optional pause after each call per worker (default 0)
 */

const MILLIONS_API_BASE_URL = 'https://api.millionverifier.com/api/v3/';

function getVerifyConcurrency(override) {
  if (Number.isFinite(override) && override >= 1) {
    return Math.min(50, Math.floor(override));
  }
  const n = parseInt(process.env.MILLIONS_VERIFY_CONCURRENCY || '', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(50, n) : 10;
}

function getVerifyDelayMs() {
  const n = parseInt(process.env.MILLIONS_VERIFY_DELAY_MS || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verify a single email address using Millions API
 * @param {string} email - Email address to verify
 * @param {string} apiKey - Millions API key
 * @param {number} timeout - Timeout in seconds (default: 10)
 * @returns {Promise<Object>} Verification result
 */
export async function verifyEmail(email, apiKey, timeout = 10) {
  try {
    const url = `${MILLIONS_API_BASE_URL}?api=${apiKey}&email=${encodeURIComponent(email)}&timeout=${timeout}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Millions API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    const apiError = String(data.error || '').trim();
    if (apiError) {
      return {
        success: false,
        email,
        status: 'error',
        error: apiError,
        result: data.result ?? null,
        resultcode: data.resultcode ?? null,
        quality: data.quality ?? null,
      };
    }

    if (!data.email) {
      return {
        success: false,
        email,
        status: 'error',
        error: 'Millions API returned no email in response',
        result: data.result ?? null,
        resultcode: data.resultcode ?? null,
        quality: data.quality ?? null,
      };
    }

    // Map Millions quality and result to our millionsStatus
    // quality: "good", "bad", "risky"
    // result: "ok", "catch_all", "unknown", "error", "disposable", "invalid"
    let status = 'bad'; // Default to bad
    
    if (data.quality === 'good') {
      status = 'good';
    } else if (data.quality === 'risky') {
      // Only set as risky if result is ok, catch_all, or unknown
      if (data.result === 'ok' || data.result === 'catch_all' || data.result === 'unknown') {
        status = 'risky';
      } else {
        status = 'bad';
      }
    } else {
      // quality is "bad" or any other value
      status = 'bad';
    }

    return {
      success: true,
      email: data.email,
      status: status,
      result: data.result,
      resultcode: data.resultcode,
      quality: data.quality,
      free: data.free,
      role: data.role,
      didyoumean: data.didyoumean,
      credits: data.credits,
      executiontime: data.executiontime,
      error: data.error,
      livemode: data.livemode,
    };
  } catch (error) {
    console.error(`Error verifying email ${email}:`, error);
    return {
      success: false,
      email: email,
      status: 'error',
      error: error.message,
    };
  }
}

/**
 * Verify multiple emails with a bounded worker pool (parallel single-email API calls).
 * @param {Array<string>} emails - Array of email addresses
 * @param {string} apiKey - Millions API key
 * @param {Function} onProgress - Called after each verification (email, result, completedCount, total)
 * @param {{ concurrency?: number }} [options]
 * @returns {Promise<Array>} Array of verification results (same order as input emails)
 */
export async function verifyEmailsBulk(emails, apiKey, onProgress = null, options = {}) {
  const list = Array.isArray(emails) ? emails : [];
  if (!list.length) return [];

  const concurrency = getVerifyConcurrency(options?.concurrency);
  const delayMs = getVerifyDelayMs();
  const results = new Array(list.length);
  let cursor = 0;
  let completed = 0;

  console.log(
    `[millions] Verifying ${list.length} email(s) with concurrency=${concurrency}` +
      (delayMs ? ` delayMs=${delayMs}` : '')
  );

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= list.length) return;

      const email = list[i];
      const result = await verifyEmail(email, apiKey);
      results[i] = result;
      completed += 1;

      if (onProgress) {
        await onProgress(email, result, completed, list.length);
      }

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  const workerCount = Math.min(concurrency, list.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
