/**
 * Rank job titles for same-company lead filtering.
 * Higher score wins (e.g. CEO over CTO).
 */

const RANK_RULES = [
  // Top executive / founder
  { score: 100, pattern: /\b(chief\s+executive\s+officer|\bceo\b)\b/i },
  { score: 95, pattern: /\b(co[-\s]?founder|founder|owner|proprietor)\b/i },
  { score: 90, pattern: /\b(president|managing\s+director|managing\s+partner)\b/i },
  // Other C-suite (below CEO/founder)
  { score: 70, pattern: /\b(chief\s+\w+\s+officer|\bc[a-z]o\b)\b/i },
  { score: 65, pattern: /\b(cto|cfo|coo|cmo|cro|cpo|cio|ciso)\b/i },
  // VP / Director tier
  { score: 50, pattern: /\b(executive\s+vice\s+president|\bevp\b|senior\s+vice\s+president|\bsvp\b|vice\s+president|\bvp\b)\b/i },
  { score: 40, pattern: /\b(director|head\s+of)\b/i },
  { score: 30, pattern: /\b(manager|lead)\b/i },
];

export function getJobTitlePriority(title) {
  const s = String(title || '').trim();
  if (!s) return 0;

  let best = 0;
  for (const rule of RANK_RULES) {
    if (rule.pattern.test(s) && rule.score > best) {
      best = rule.score;
    }
  }
  return best;
}

/**
 * Among candidates with the same company key, keep only the highest-priority title.
 * Ties keep the earliest row. Candidates without a company key are all kept.
 *
 * @param {Array<{ companyKey: string|null, titlePriority: number, rowIndex: number }>} candidates
 * @returns {{ winners: typeof candidates, skipped: Array<{ candidate: any, kept: any }> }}
 */
export function pickBestLeadPerCompany(candidates) {
  const byCompany = new Map();
  const noCompany = [];

  for (const c of candidates) {
    if (!c.companyKey) {
      noCompany.push(c);
      continue;
    }
    const list = byCompany.get(c.companyKey) || [];
    list.push(c);
    byCompany.set(c.companyKey, list);
  }

  const winners = [...noCompany];
  const skipped = [];

  for (const list of byCompany.values()) {
    list.sort((a, b) => {
      if (b.titlePriority !== a.titlePriority) return b.titlePriority - a.titlePriority;
      return a.rowIndex - b.rowIndex;
    });
    const best = list[0];
    winners.push(best);
    for (let i = 1; i < list.length; i++) {
      skipped.push({ candidate: list[i], kept: best });
    }
  }

  winners.sort((a, b) => a.rowIndex - b.rowIndex);
  return { winners, skipped };
}
