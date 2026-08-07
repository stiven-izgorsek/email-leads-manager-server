import dotenv from 'dotenv';
dotenv.config();

import { createChatCompletion } from '../src/services/applicationService.js';

const industry = process.argv[2] || 'AI-image';
const requestedType = process.argv[3] || 'outreach';

const systemPrompt = [
  'You generate cold outreach message templates for a software engineer job-seeker.',
  'Return only valid JSON.',
  'The JSON must have a key "templates" containing exactly 3 templates.',
  'Generate one template each for sizes: short, normal, long.',
  'Each template must include keys: size, content.',
  'Use placeholders like {{firstName}}, {{companyName}}, and {{senderName}}.',
  'Do not use {{icebreakerTitle}} or {{icebreaker}} placeholders.',
  'Placeholder syntax must be exact. Do not put any extra words inside placeholders. Use exactly {{companyName}} (never {{companyName is ...}}).',
  'Do not nest placeholders inside {{RANDOM|...}}; only the randomized opener sentences should be inside the RANDOM block.',
  'Every template must start with "Hi {{firstName}},".',
  'Immediately after that greeting line, include exactly one {{RANDOM|...}} block for the opener/greeting content (the "why I reached out" part).',
  'The {{RANDOM|...}} block must contain exactly 3 alternative opener sentences tailored to the selected industry.',
  'Each of the 3 alternative opener sentences must be different from the others (not repeated verbatim).',
  'Do NOT reuse the same three opener sentences across short/normal/long; vary the opener options per template.',
  'For RANDOM blocks, use exactly: {{RANDOM|option1|option2|option3}} (no trailing "|" before "}}").',
  'Do not use emoji.',
  'Do not mention project names or URLs.',
  'Never use phrases like "I hope this message finds you well", "hope you are well", or similar generic well-wishing openers.',
  'Prefer a simple direct greeting such as "Hi {{firstName}}," followed by the body.',
  'Keep the templates reusable for the specified industry.',
].join(' ');

const userPrompt = JSON.stringify({
  type: requestedType,
  industry,
  industryNote: '',
  outputRequirements: {
    count: 3,
    sizes: ['short', 'normal', 'long'],
    styleExample: [
      'Hi {{firstName}},',
      '',
      '{{RANDOM|<opener option 1>|<opener option 2>|<opener option 3>}}',
      '',
      'I’ve been working as a Software Engineer on AI-driven applications, including systems focused on user-facing healthcare experiences.',
      '',
      'If that aligns with anything at {{companyName}}, happy to connect.',
      '',
      'Best,',
      '{{senderName}}',
    ].join('\n'),
    instructions: [
      'Generate templates appropriate for the selected industry.',
      'Short = concise, Normal = balanced, Long = more detailed.',
      'The sender is an individual developer exploring software engineering opportunities.',
      'Templates should sound like outreach for potential roles or collaboration around building the right product.',
      'Do not use "I hope this message finds you well" or close variants.',
      'Replace the literal placeholders "<opener option 1/2/3>" with real, industry-specific opener sentences.',
      'The opener sentences inside {{RANDOM|...}} must be the “why I reached out / what I’m interested in” lines, and should be different across each template size.',
    ],
  },
});

try {
  const raw = await createChatCompletion([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]);

  console.log('OpenAI call OK. Raw length:', raw.length);
  console.log(raw.slice(0, 300));
} catch (err) {
  console.error('OpenAI call FAILED:', err?.message || err);
  process.exit(1);
}

