import {
  getRelevantPortfolioContext,
  createChatCompletion,
} from '../services/applicationService.js';

const COVER_LETTER_SYSTEM = `You are a senior software engineer with deep experience in AI/ML and full-stack engineering, writing a professional cover letter for a job application.

Write in first person using simple, natural English. Use easy words and short sentences. Prefer wording like "I built...", "I developed...", "I worked on...", "I have experience with...", and "I have deep knowledge of...".

The applicant is a senior engineer. When it is relevant and truthful based on the provided portfolio, make it clear that the applicant has at least 7 years of experience in each main area they apply with. State this naturally, for example "I have over 7 years of experience with backend development" or "I have 7+ years of experience building web applications".

Do not use AI-sounding phrases such as "My experience also includes", "I successfully shipped", "I am particularly drawn to the mission", "I am excited to contribute meaningfully", or similar formal marketing language.

Do not use the em dash character. Never output "—". Avoid fancy punctuation and avoid overly polished wording.

Be specific and credible. Ground claims in the portfolio context when relevant, and do not invent projects or achievements.

Output only the letter body: no subject line, no markdown, no bullet lists, and no headings. Use "Hello," as the salutation unless the job description gives a specific contact name. Use short paragraphs separated by blank lines. End with a short final paragraph before the sign-off. Do not include "Best regards" or the applicant name at the end because the UI adds that part.`;

const ANSWER_SYSTEM = `You are a senior software engineer with deep experience in AI/ML and full-stack engineering, answering application or interview questions.

Use simple, natural English. Use easy words and short sentences. Prefer wording like "I built...", "I developed...", "I worked on...", "I have experience with...", and "I have deep knowledge of...".

When it fits the question and the provided portfolio supports it, make it clear that the applicant has at least 7 years of experience in the relevant area.

Do not use AI-sounding phrases such as "My experience also includes", "I successfully shipped", "I am particularly drawn to the mission", or similar formal marketing language.

Do not use the em dash character. Never output "—". Avoid fancy punctuation.

Be concise, specific, and grounded in the portfolio context when it helps. Keep the answer short and direct, usually 3 to 6 sentences. No markdown unless the question asks for code.`;

const MESSAGE_REPLY_SYSTEM = `You are a senior software engineer with deep experience in AI/ML and full-stack engineering, writing a reply to a message or chat conversation.

Use simple, natural English. Use easy words and short sentences. Sound human and direct.

Use the chat history to understand the latest message, what the other person is asking, and what tone fits best. Use the portfolio context only when it helps support the reply.

Do not use AI-sounding phrases. Do not use the em dash character. Never output "—". Avoid fancy punctuation.

Write only the reply message body. No markdown, no bullet lists, no headings, and no quotation marks around the reply. Keep it concise unless the conversation clearly needs more detail.`;

function normalizeGeneratedText(text) {
  return text.replaceAll('—', '-').trim();
}

export async function postCoverLetter(req, res) {
  try {
    const {
      companyName,
      jobDescription,
      fullName,
      title,
      email,
      linkedin,
      address,
      date,
    } = req.body || {};

    if (!jobDescription || typeof jobDescription !== 'string' || !jobDescription.trim()) {
      return res.status(400).json({ error: 'jobDescription is required' });
    }
    if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
      return res.status(400).json({ error: 'fullName is required' });
    }

    const portfolioContext = getRelevantPortfolioContext(jobDescription, {
      maxSections: 4,
      maxChars: 7000,
    });

    const applicantBlock = [
      companyName ? `Target company: ${companyName}` : null,
      `Applicant name: ${fullName}`,
      title ? `Professional title: ${title}` : null,
      email ? `Email: ${email}` : null,
      linkedin ? `LinkedIn: ${linkedin}` : null,
      address ? `Location: ${address}` : null,
      date ? `Letter date: ${date}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const userContent = `Job description:\n${jobDescription.trim()}\n\n---\nPortfolio and experience (reference selectively; do not invent projects):\n${portfolioContext || '(No portfolio file loaded.)'}\n\n---\n${applicantBlock}\n\nWrite the cover letter body as specified.`;

    const content = await createChatCompletion([
      { role: 'system', content: COVER_LETTER_SYSTEM },
      { role: 'user', content: userContent },
    ]);

    res.json({ content: normalizeGeneratedText(content) });
  } catch (error) {
    console.error('postCoverLetter error:', error);
    const status = error.status || 500;
    res.status(status).json({ error: error.message || 'Failed to generate cover letter' });
  }
}

export async function postAnswerQuestion(req, res) {
  try {
    const { jobDescription, question } = req.body || {};

    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'question is required' });
    }

    const portfolioContext = getRelevantPortfolioContext(
      `${question}\n${jobDescription || ''}`,
      { maxSections: 3, maxChars: 5000 }
    );

    const jdPart =
      jobDescription && typeof jobDescription === 'string' && jobDescription.trim()
        ? `Job description (context):\n${jobDescription.trim()}\n\n---\n`
        : '';

    const userContent = `${jdPart}Portfolio and experience (reference when relevant):\n${portfolioContext || '(No portfolio file loaded.)'}\n\n---\nQuestion:\n${question.trim()}`;

    const answer = await createChatCompletion([
      { role: 'system', content: ANSWER_SYSTEM },
      { role: 'user', content: userContent },
    ]);

    res.json({ answer: normalizeGeneratedText(answer) });
  } catch (error) {
    console.error('postAnswerQuestion error:', error);
    const status = error.status || 500;
    res.status(status).json({ error: error.message || 'Failed to generate answer' });
  }
}

export async function postMessageReply(req, res) {
  try {
    const { chatHistory, jobDescription } = req.body || {};

    if (!chatHistory || typeof chatHistory !== 'string' || !chatHistory.trim()) {
      return res.status(400).json({ error: 'chatHistory is required' });
    }

    const portfolioContext = getRelevantPortfolioContext(
      `${chatHistory}\n${jobDescription || ''}`,
      { maxSections: 3, maxChars: 5000 }
    );

    const jdPart =
      jobDescription && typeof jobDescription === 'string' && jobDescription.trim()
        ? `Job description (context):\n${jobDescription.trim()}\n\n---\n`
        : '';

    const userContent = `${jdPart}Portfolio and experience (reference only if relevant):\n${portfolioContext || '(No portfolio file loaded.)'}\n\n---\nChat history:\n${chatHistory.trim()}\n\n---\nWrite the best reply to send next.`;

    const reply = await createChatCompletion([
      { role: 'system', content: MESSAGE_REPLY_SYSTEM },
      { role: 'user', content: userContent },
    ]);

    res.json({ reply: normalizeGeneratedText(reply) });
  } catch (error) {
    console.error('postMessageReply error:', error);
    const status = error.status || 500;
    res.status(status).json({ error: error.message || 'Failed to generate reply' });
  }
}
