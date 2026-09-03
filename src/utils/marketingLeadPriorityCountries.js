/** Default priority countries when reclaiming used leads (ordering, not hard filter). */
export const DEFAULT_USED_LEAD_PRIORITY_COUNTRIES = [
  'germany',
  'united kingdom',
  'uk',
  'great britain',
  'england',
  'netherlands',
  'holland',
  'belgium',
];

/**
 * @param {string[]|string|null|undefined} raw
 * @returns {string[]}
 */
export function normalizePriorityCountries(raw) {
  if (raw == null) return [...DEFAULT_USED_LEAD_PRIORITY_COUNTRIES];
  const list = Array.isArray(raw)
    ? raw
    : String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  return [...new Set(list.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
}

/**
 * Order leads from priority countries first (location / companyLocation ILIKE).
 * @param {import('typeorm').SelectQueryBuilder<any>} qb
 * @param {string[]} priorityCountries
 * @param {string} [alias='client']
 */
export function applyLeadPriorityCountryOrder(qb, priorityCountries, alias = 'client') {
  const keywords =
    priorityCountries == null
      ? [...DEFAULT_USED_LEAD_PRIORITY_COUNTRIES]
      : normalizePriorityCountries(priorityCountries);
  if (!keywords.length) return false;

  const parts = [];
  const params = {};
  keywords.forEach((loc, i) => {
    const key = `priCountry${i}`;
    parts.push(`(${alias}.location ILIKE :${key} OR ${alias}.companyLocation ILIKE :${key})`);
    params[key] = `%${loc}%`;
  });
  for (const [key, value] of Object.entries(params)) {
    qb.setParameter(key, value);
  }
  qb.orderBy(`CASE WHEN (${parts.join(' OR ')}) THEN 0 ELSE 1 END`, 'ASC');
  return true;
}
