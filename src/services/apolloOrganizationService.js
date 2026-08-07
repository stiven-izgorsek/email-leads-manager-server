const APOLLO_SEARCH_URL = 'https://api.apollo.io/api/v1/mixed_companies/search';

function toStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

/**
 * Build URLSearchParams for Apollo Organization Search (POST with query string per API docs).
 * @param {Record<string, unknown>} filters - Apollo filter keys (snake_case as in API)
 * @param {number} page
 * @param {number} perPage - max 100
 */
export function buildApolloSearchQuery(filters, page, perPage) {
  const sp = new URLSearchParams();
  const p = Math.max(1, parseInt(String(page), 10) || 1);
  const pp = Math.min(100, Math.max(1, parseInt(String(perPage), 10) || 25));
  sp.set('page', String(p));
  sp.set('per_page', String(pp));

  const f = filters && typeof filters === 'object' ? filters : {};

  if (toStr(f.q_organization_name)) sp.set('q_organization_name', toStr(f.q_organization_name));

  const domains = Array.isArray(f.q_organization_domains_list) ? f.q_organization_domains_list : [];
  for (const d of domains) {
    const t = toStr(d);
    if (t) sp.append('q_organization_domains_list[]', t);
  }

  const empRanges = Array.isArray(f.organization_num_employees_ranges) ? f.organization_num_employees_ranges : [];
  for (const r of empRanges) {
    const t = toStr(r);
    if (t) sp.append('organization_num_employees_ranges[]', t);
  }

  const locs = Array.isArray(f.organization_locations) ? f.organization_locations : [];
  for (const x of locs) {
    const t = toStr(x);
    if (t) sp.append('organization_locations[]', t);
  }

  const notLocs = Array.isArray(f.organization_not_locations) ? f.organization_not_locations : [];
  for (const x of notLocs) {
    const t = toStr(x);
    if (t) sp.append('organization_not_locations[]', t);
  }

  const rr = f.revenue_range && typeof f.revenue_range === 'object' ? f.revenue_range : {};
  if (rr.min != null && rr.min !== '') sp.set('revenue_range[min]', String(rr.min));
  if (rr.max != null && rr.max !== '') sp.set('revenue_range[max]', String(rr.max));

  const tech = Array.isArray(f.currently_using_any_of_technology_uids) ? f.currently_using_any_of_technology_uids : [];
  for (const x of tech) {
    const t = toStr(x);
    if (t) sp.append('currently_using_any_of_technology_uids[]', t);
  }

  const tags = Array.isArray(f.q_organization_keyword_tags) ? f.q_organization_keyword_tags : [];
  for (const x of tags) {
    const t = toStr(x);
    if (t) sp.append('q_organization_keyword_tags[]', t);
  }

  const orgIds = Array.isArray(f.organization_ids) ? f.organization_ids : [];
  for (const x of orgIds) {
    const t = toStr(x);
    if (t) sp.append('organization_ids[]', t);
  }

  const lfa = f.latest_funding_amount_range && typeof f.latest_funding_amount_range === 'object' ? f.latest_funding_amount_range : {};
  if (lfa.min != null && lfa.min !== '') sp.set('latest_funding_amount_range[min]', String(lfa.min));
  if (lfa.max != null && lfa.max !== '') sp.set('latest_funding_amount_range[max]', String(lfa.max));

  const tfa = f.total_funding_range && typeof f.total_funding_range === 'object' ? f.total_funding_range : {};
  if (tfa.min != null && tfa.min !== '') sp.set('total_funding_range[min]', String(tfa.min));
  if (tfa.max != null && tfa.max !== '') sp.set('total_funding_range[max]', String(tfa.max));

  const lfd = f.latest_funding_date_range && typeof f.latest_funding_date_range === 'object' ? f.latest_funding_date_range : {};
  if (toStr(lfd.min)) sp.set('latest_funding_date_range[min]', toStr(lfd.min));
  if (toStr(lfd.max)) sp.set('latest_funding_date_range[max]', toStr(lfd.max));

  const jobs = Array.isArray(f.q_organization_job_titles) ? f.q_organization_job_titles : [];
  for (const x of jobs) {
    const t = toStr(x);
    if (t) sp.append('q_organization_job_titles[]', t);
  }

  const jobLocs = Array.isArray(f.organization_job_locations) ? f.organization_job_locations : [];
  for (const x of jobLocs) {
    const t = toStr(x);
    if (t) sp.append('organization_job_locations[]', t);
  }

  const nj = f.organization_num_jobs_range && typeof f.organization_num_jobs_range === 'object' ? f.organization_num_jobs_range : {};
  if (nj.min != null && nj.min !== '') sp.set('organization_num_jobs_range[min]', String(nj.min));
  if (nj.max != null && nj.max !== '') sp.set('organization_num_jobs_range[max]', String(nj.max));

  const jpr = f.organization_job_posted_at_range && typeof f.organization_job_posted_at_range === 'object' ? f.organization_job_posted_at_range : {};
  if (toStr(jpr.min)) sp.set('organization_job_posted_at_range[min]', toStr(jpr.min));
  if (toStr(jpr.max)) sp.set('organization_job_posted_at_range[max]', toStr(jpr.max));

  return sp;
}

export function getApolloApiKey() {
  return (process.env.APOLLO_API_KEY || '').trim();
}

/**
 * @returns {Promise<{ ok: boolean, status: number, json?: any, text?: string }>}
 */
export async function postApolloOrganizationSearch(filters, page, perPage) {
  const apiKey = getApolloApiKey();
  if (!apiKey) {
    return { ok: false, status: 503, text: 'APOLLO_API_KEY is not configured' };
  }

  const sp = buildApolloSearchQuery(filters, page, perPage);
  const url = `${APOLLO_SEARCH_URL}?${sp.toString()}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({}),
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = null;
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      text: json?.message || json?.error || text || res.statusText,
      json,
    };
  }

  return { ok: true, status: res.status, json };
}
