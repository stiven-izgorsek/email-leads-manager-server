/**
 * Apollo People Enrichment via LinkedIn URL.
 * Docs: POST https://api.apollo.io/api/v1/people/bulk_match (up to 10 per request)
 * Single: POST https://api.apollo.io/api/v1/people/match
 */
import { normalizeLinkedInUrl } from '../utils/linkedinUrl.js';
import { yieldToEventLoop } from '../utils/backgroundWork.js';

const APOLLO_BULK_MATCH_URL = 'https://api.apollo.io/api/v1/people/bulk_match';
const BULK_BATCH_SIZE = 10;

function pickEmailFromPerson(person) {
  if (!person || typeof person !== 'object') return null;
  const candidates = [
    person.email,
    person.work_email,
    person.corporate_email,
    ...(Array.isArray(person.email_status) ? [] : []),
  ];
  if (Array.isArray(person.emails)) {
    for (const item of person.emails) {
      if (typeof item === 'string') candidates.push(item);
      else if (item?.email) candidates.push(item.email);
    }
  }
  for (const raw of candidates) {
    const email = String(raw || '').trim().toLowerCase();
    if (email && email.includes('@') && !email.includes('email_not_unlocked')) {
      return email;
    }
  }
  return null;
}

/**
 * @param {string} apiKey
 * @param {Array<{ id?: string, linkedin: string, firstName?: string|null, lastName?: string|null, companyName?: string|null, companyUrl?: string|null }>} people
 * @param {{ onBatch?: (info: { processed: number, total: number, batchResults: any[] }) => void | Promise<void> }} [options]
 */
export async function bulkEnrichPeopleByLinkedIn(apiKey, people, options = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('Apollo API key is required');

  const results = [];
  const list = Array.isArray(people) ? people : [];
  const onBatch = typeof options.onBatch === 'function' ? options.onBatch : null;

  for (let i = 0; i < list.length; i += BULK_BATCH_SIZE) {
    const chunk = list.slice(i, i + BULK_BATCH_SIZE);
    const details = chunk.map((p) => {
      const linkedinUrl = normalizeLinkedInUrl(p.linkedin);
      const detail = { linkedin_url: linkedinUrl };
      if (p.firstName) detail.first_name = p.firstName;
      if (p.lastName) detail.last_name = p.lastName;
      if (p.companyName) detail.organization_name = p.companyName;
      if (p.companyUrl) {
        try {
          const host = new URL(
            /^https?:\/\//i.test(p.companyUrl) ? p.companyUrl : `https://${p.companyUrl}`
          ).hostname.replace(/^www\./i, '');
          if (host) detail.domain = host;
        } catch {
          // ignore bad company url
        }
      }
      return detail;
    });

    const response = await fetch(
      `${APOLLO_BULK_MATCH_URL}?reveal_personal_emails=false`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'X-Api-Key': key,
        },
        body: JSON.stringify({ details }),
      }
    );

    const rawText = await response.text();
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const msg =
        payload?.error ||
        payload?.message ||
        rawText ||
        `Apollo API error (${response.status})`;
      throw new Error(String(msg));
    }

    const matches = Array.isArray(payload?.matches)
      ? payload.matches
      : Array.isArray(payload?.people)
        ? payload.people
        : [];

    const batchResults = [];
    for (let j = 0; j < chunk.length; j += 1) {
      const input = chunk[j];
      const match = matches[j] || null;
      const person = match?.person || match || null;
      const email = pickEmailFromPerson(person);
      const row = {
        id: input.id || null,
        linkedin: normalizeLinkedInUrl(input.linkedin),
        email,
        matched: Boolean(person && (person.id || email || person.name)),
        status: match?.status || (email ? 'success' : 'no_email'),
        rawPerson: person,
      };
      batchResults.push(row);
      results.push(row);
    }

    if (onBatch) {
      await onBatch({
        processed: results.length,
        total: list.length,
        batchResults,
      });
    }

    // Gentle pacing between Apollo bulk batches
    if (i + BULK_BATCH_SIZE < list.length) {
      await yieldToEventLoop();
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return results;
}

export { BULK_BATCH_SIZE };
