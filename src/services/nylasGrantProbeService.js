import { getNylasBaseUrls } from './nylasCalendarService.js';
import { NYLAS_LIST_PAGE_LIMIT } from '../utils/nylasRateLimit.js';

const configuredNylasRegion = (process.env.NYLAS_REGION || '').toLowerCase();

/**
 * Lightweight Nylas call to verify grant + API key (same list endpoint style as polling).
 * @returns {{ ok: boolean, code: string, httpStatus: number | null, detail: string, region?: string }}
 */
export async function probeNylasGrantMessagesList(grantId, nylasKey) {
  const gid = String(grantId || '').trim();
  const key = String(nylasKey || '').trim();
  if (!gid || !key) {
    return {
      ok: false,
      code: 'incomplete',
      httpStatus: null,
      detail: 'Grant ID and Nylas API key are both required for a live check.',
    };
  }

  let last = { status: 0, text: '', baseUrl: '' };

  for (const baseUrl of getNylasBaseUrls()) {
    const url = `${baseUrl}/v3/grants/${encodeURIComponent(gid)}/messages?limit=${NYLAS_LIST_PAGE_LIMIT}`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
        },
      });
      const text = await response.text().catch(() => '');
      if (response.ok) {
        return { ok: true, code: 'ok', httpStatus: 200, detail: '', region: baseUrl };
      }
      last = { status: response.status, text, baseUrl };
      if (response.status === 401 && configuredNylasRegion) {
        break;
      }
    } catch (err) {
      last = { status: 0, text: String(err?.message || err), baseUrl };
      if (configuredNylasRegion) break;
    }
  }

  const { status, text } = last;
  const snippet = text.length > 600 ? `${text.slice(0, 600)}…` : text;

  if (status === 401) {
    return {
      ok: false,
      code: 'invalid_api_key',
      httpStatus: 401,
      detail: snippet || 'Unauthorized (invalid or revoked Nylas API key for this app).',
    };
  }
  if (status === 404) {
    return {
      ok: false,
      code: 'grant_not_found',
      httpStatus: 404,
      detail: snippet || 'Grant not found (wrong region or grant revoked).',
    };
  }
  if (status === 403) {
    return {
      ok: false,
      code: 'forbidden',
      httpStatus: 403,
      detail: snippet || 'Forbidden for this grant or key.',
    };
  }
  if (status === 429) {
    return {
      ok: false,
      code: 'rate_limited',
      httpStatus: 429,
      detail: snippet || 'Rate limited; try again later.',
    };
  }
  if (status === 0) {
    return {
      ok: false,
      code: 'network_error',
      httpStatus: null,
      detail: snippet || 'Network error contacting Nylas.',
    };
  }

  return {
    ok: false,
    code: 'error',
    httpStatus: status,
    detail: snippet || `HTTP ${status}`,
  };
}
