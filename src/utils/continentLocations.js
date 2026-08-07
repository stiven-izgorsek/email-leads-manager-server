/**
 * Continent → location keywords for marketing lead assignment.
 * Matched with ILIKE against client.location / client.companyLocation.
 */

export const MARKETING_CONTINENTS = ['asia', 'europe', 'america'];

/** @type {Record<string, string[]>} */
const CONTINENT_LOCATION_KEYWORDS = {
  asia: [
    'afghanistan',
    'armenia',
    'azerbaijan',
    'bahrain',
    'bangladesh',
    'bhutan',
    'brunei',
    'cambodia',
    'china',
    'cyprus',
    'georgia',
    'hong kong',
    'india',
    'indonesia',
    'iran',
    'iraq',
    'israel',
    'japan',
    'jordan',
    'kazakhstan',
    'kuwait',
    'kyrgyzstan',
    'laos',
    'lebanon',
    'macau',
    'malaysia',
    'maldives',
    'mongolia',
    'myanmar',
    'nepal',
    'north korea',
    'oman',
    'pakistan',
    'palestine',
    'philippines',
    'qatar',
    'saudi arabia',
    'singapore',
    'south korea',
    'korea',
    'sri lanka',
    'syria',
    'taiwan',
    'tajikistan',
    'thailand',
    'timor',
    'turkey',
    'turkiye',
    'türkiye',
    'turkmenistan',
    'uae',
    'united arab emirates',
    'uzbekistan',
    'vietnam',
    'yemen',
    'asia',
  ],
  europe: [
    'albania',
    'andorra',
    'austria',
    'belarus',
    'belgium',
    'bosnia',
    'bulgaria',
    'croatia',
    'czech',
    'denmark',
    'estonia',
    'finland',
    'france',
    'germany',
    'greece',
    'hungary',
    'iceland',
    'ireland',
    'italy',
    'kosovo',
    'latvia',
    'liechtenstein',
    'lithuania',
    'luxembourg',
    'malta',
    'moldova',
    'monaco',
    'montenegro',
    'netherlands',
    'holland',
    'north macedonia',
    'macedonia',
    'norway',
    'poland',
    'portugal',
    'romania',
    'russia',
    'san marino',
    'serbia',
    'slovakia',
    'slovenia',
    'spain',
    'sweden',
    'switzerland',
    'ukraine',
    'united kingdom',
    'uk',
    'england',
    'scotland',
    'wales',
    'northern ireland',
    'vatican',
    'europe',
  ],
  america: [
    'united states',
    'usa',
    'u.s.',
    'u.s.a.',
    'america',
    'canada',
    'mexico',
    'argentina',
    'bolivia',
    'brazil',
    'chile',
    'colombia',
    'costa rica',
    'cuba',
    'dominican republic',
    'ecuador',
    'el salvador',
    'guatemala',
    'haiti',
    'honduras',
    'jamaica',
    'nicaragua',
    'panama',
    'paraguay',
    'peru',
    'puerto rico',
    'uruguay',
    'venezuela',
    'trinidad',
    'bahamas',
    'barbados',
    'belize',
    'guyana',
    'suriname',
    'north america',
    'south america',
    'latin america',
    // Common US state names (when country omitted in location)
    'california',
    'new york',
    'texas',
    'florida',
    'illinois',
    'washington',
    'massachusetts',
    'pennsylvania',
    'ohio',
    'georgia',
    'north carolina',
    'michigan',
    'new jersey',
    'virginia',
    'arizona',
    'colorado',
    'oregon',
  ],
};

/**
 * @param {unknown} raw
 * @returns {'asia'|'europe'|'america'|null}
 */
export function normalizeMarketingContinent(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (s === 'asia' || s === 'as') return 'asia';
  if (s === 'europe' || s === 'eu' || s === 'eur') return 'europe';
  if (s === 'america' || s === 'americas' || s === 'na' || s === 'sa' || s === 'us') return 'america';
  return null;
}

/**
 * @param {unknown} raw
 * @returns {'1/2'|'1/3'|'all'|null}
 */
export function normalizeAssignFraction(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (s === '1/2' || s === 'half' || s === '2') return '1/2';
  if (s === '1/3' || s === 'third' || s === '3') return '1/3';
  if (s === 'all' || s === '1' || s === '1/1') return 'all';
  return null;
}

/**
 * @param {'asia'|'europe'|'america'|null} continent
 * @returns {string[]}
 */
export function getContinentLocationKeywords(continent) {
  if (!continent) return [];
  return CONTINENT_LOCATION_KEYWORDS[continent] || [];
}

/**
 * How many leads to assign this round from daily capacity.
 * With continent + 1/n: floor(dailyLimit / n), clamped by remaining.
 * Without continent (or "all"): remaining capacity (fill toward daily limit).
 *
 * @param {number} remaining
 * @param {number} dailyLimit
 * @param {'1/2'|'1/3'|'all'|null} fraction
 * @param {boolean} continentSelected
 */
export function resolveFractionalAssignCount(remaining, dailyLimit, fraction, continentSelected) {
  const rem = Math.max(0, Math.min(500, Math.floor(remaining) || 0));
  if (!rem) return 0;
  if (!continentSelected || !fraction || fraction === 'all') return rem;

  const limit = Math.max(1, Math.floor(dailyLimit) || rem);
  const divisor = fraction === '1/2' ? 2 : fraction === '1/3' ? 3 : 1;
  if (divisor <= 1) return rem;
  return Math.max(0, Math.min(rem, Math.floor(limit / divisor)));
}
