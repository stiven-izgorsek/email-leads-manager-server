/**
 * Millions Email Verification Service
 * API Documentation: https://api.millionverifier.com/api/v3/
 */

const MILLIONS_API_BASE_URL = 'https://api.millionverifier.com/api/v3/';

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
 * Verify multiple emails sequentially
 * @param {Array<string>} emails - Array of email addresses
 * @param {string} apiKey - Millions API key
 * @param {Function} onProgress - Callback function called after each verification (email, result, index, total)
 * @returns {Promise<Array>} Array of verification results
 */
export async function verifyEmailsBulk(emails, apiKey, onProgress = null) {
  const results = [];
  
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    const result = await verifyEmail(email, apiKey);
    results.push(result);
    
    if (onProgress) {
      onProgress(email, result, i + 1, emails.length);
    }
    
    // Add a small delay to avoid rate limiting (adjust as needed)
    if (i < emails.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  return results;
}
