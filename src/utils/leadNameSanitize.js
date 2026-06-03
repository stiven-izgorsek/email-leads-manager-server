/**
 * Apollo / AI-sourced leads sometimes use "?" in names so recipients can spot automation.
 * Strip those markers on API responses (and optional writes) by replacing with spaces.
 */

export function sanitizeAiMarkerInName(value) {
  if (value == null) return null;
  const s = String(value);
  if (!s) return null;
  if (!s.includes('?')) return s;
  const cleaned = s.replace(/\?+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length ? cleaned : null;
}

/** Mutates and returns the same object for convenience on plain records. */
export function sanitizeClientNameFields(record) {
  if (!record || typeof record !== 'object') return record;
  for (const key of ['firstName', 'lastName', 'companyName', 'first_name', 'last_name', 'company_name']) {
    if (key in record && record[key] != null) {
      record[key] = sanitizeAiMarkerInName(record[key]);
    }
  }
  return record;
}

export function sanitizeClientNameFieldsCopy(record) {
  if (!record || typeof record !== 'object') return record;
  return sanitizeClientNameFields({ ...record });
}

/** CRM / leads list API shape (Client entity or plain object). */
export function serializeClientLeadForApi(client) {
  if (!client) return client;
  return sanitizeClientNameFieldsCopy(client);
}

/** Gmail extension GET /leads/uncontacted response row. */
export function formatUncontactedLeadForExtension(lead) {
  const firstName = sanitizeAiMarkerInName(lead.firstName) || '';
  const companyName = sanitizeAiMarkerInName(lead.companyName) || '';
  return {
    id: lead.id,
    first_name: firstName,
    firstName,
    company_name: companyName,
    companyName,
    companyUrl: lead.companyUrl || '',
    industries: lead.industries || [],
    tech: lead.tech || [],
    jobTitle: lead.jobTitle || '',
    companyLocation: lead.companyLocation || '',
    email: lead.email || '',
    icebreaker_title: null,
    icebreaker: null,
    status: lead.status || 'ready',
    used: false,
  };
}
