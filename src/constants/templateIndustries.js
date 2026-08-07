/**
 * Canonical industry keys for cold-message templates (must stay in sync with
 * email-leads-manager-app/src/lib/template-industries.ts).
 */
export const COMPANY_CATEGORIES = [
  'AI-image',
  'AI-chatbot',
  'AI-healthcare',
  'AI-automation',
  'AI-audio',
  'AI-CRM',
  'AI-unknown',
  'CRM',
  'E-commerce',
  'ecom+luxury',
  'E-learning',
  'Fintech',
  'Document-generation',
  'healthcare',
  'petcare',
  'manufacturing-furniture',
  'manufacturing-pump',
  'manufacturing-unknown',
  'mqtt-energy',
  'travel',
  'unknown',
];

export const TEMPLATE_INDUSTRIES = [...COMPANY_CATEGORIES, 'Other'];

export function isValidTemplateIndustry(value) {
  const v = String(value || '').trim();
  return Boolean(v && TEMPLATE_INDUSTRIES.includes(v));
}

/** Prefer explicit compose override, then lead.templateIndustry. */
export function resolveForcedTemplateIndustry(lead, industryOverride = '') {
  const fromOverride = String(industryOverride || '').trim();
  if (isValidTemplateIndustry(fromOverride)) return fromOverride;
  if (!lead || typeof lead !== 'object') return '';
  const fromLead = String(lead.templateIndustry ?? lead.template_industry ?? '').trim();
  if (isValidTemplateIndustry(fromLead)) return fromLead;
  return '';
}
