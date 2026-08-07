import { AppDataSource } from '../config/database.js';
import { Template } from '../entities/Template.js';

const ECOM_LUXURY = 'ecom+luxury';

/**
 * Broad enough for apparel, marketing, consumer services, luxury goods,
 * supermarkets, and commercial real estate — without naming those verticals.
 * E-commerce / digital product is the highlighted strength, not the only frame.
 */
const NORMAL_CONTENT = [
  'Hi {{firstName}},',
  '',
  '{{RANDOM|I noticed {{companyName}} is investing in better digital experiences for customers and partners.|I came across {{companyName}} and was interested in how you’re using software to support growth and day-to-day operations.|I see {{companyName}} focusing on stronger customer engagement across digital channels.}}',
  '',
  'As a Software Engineer, I specialize in building reliable customer-facing products — with a particular strength in e-commerce and conversion-focused platforms, along with SaaS-style tooling and payment flows. I also build practical AI solutions (automation, assistants, and product features that use models where they actually help). I’d love to discuss how that mix could support your team at {{companyName}}.',
  '',
  'Best,',
  '{{senderName}}',
].join('\n');

const LONG_CONTENT = [
  'Hi {{firstName}},',
  '',
  '{{RANDOM|I noticed {{companyName}} is expanding how customers discover, engage, and convert through digital channels.|I came across {{companyName}} and was intrigued by the way you’re blending brand experience with practical software and operations.|I see {{companyName}} investing in smoother digital journeys — from first touch through the systems that keep service running behind the scenes.}}',
  '',
  'As a Software Engineer, I build product experiences that need to be polished and dependable under real traffic. My strongest background is e-commerce and conversion-focused platforms, and that same skill set transfers well to SaaS products, fintech-style payment/checkout flows, and internal tools for marketing and customer service teams.',
  '',
  'I also ship AI solutions end to end — from workflow automation and internal assistants to customer-facing features that use models thoughtfully, without overcomplicating the product.',
  '',
  'If that sounds relevant to what you’re building at {{companyName}}, I’d welcome a short conversation — happy to share a bit more about recent work and how it might map to your roadmap.',
  '',
  'Best,',
  '{{senderName}}',
].join('\n');

const SEED = [
  { size: 'normal', content: NORMAL_CONTENT },
  { size: 'long', content: LONG_CONTENT },
];

/**
 * Ensure mid (normal) + long outreach templates exist for ecom+luxury.
 * Updates content when a seed row already exists so copy refreshes on restart.
 */
export async function ensureEcomLuxuryOutreachTemplates() {
  const repo = AppDataSource.getRepository(Template);
  let created = 0;
  let updated = 0;

  for (const row of SEED) {
    const existing = await repo
      .createQueryBuilder('template')
      .where('template.deletedAt IS NULL')
      .andWhere('template.type = :type', { type: 'outreach' })
      .andWhere("COALESCE(template.size, 'normal') = :size", { size: row.size })
      .andWhere(
        `(template.industries = :exact
          OR template.industries LIKE :prefix
          OR template.industries LIKE :middle
          OR template.industries LIKE :suffix)`,
        {
          exact: ECOM_LUXURY,
          prefix: `${ECOM_LUXURY},%`,
          middle: `%,${ECOM_LUXURY},%`,
          suffix: `%,${ECOM_LUXURY}`,
        }
      )
      .getOne();

    if (existing) {
      if (existing.content !== row.content) {
        existing.content = row.content;
        existing.industries = [ECOM_LUXURY];
        await repo.save(existing);
        updated += 1;
      }
      continue;
    }

    await repo.save(
      repo.create({
        type: 'outreach',
        size: row.size,
        industries: [ECOM_LUXURY],
        content: row.content,
        usedCount: 0,
      })
    );
    created += 1;
  }

  if (created > 0 || updated > 0) {
    console.log(
      `[templates] ecom+luxury outreach: created ${created}, updated ${updated}`
    );
  }
}
