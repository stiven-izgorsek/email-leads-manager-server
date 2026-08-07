import { resolveAllContactUrls } from '../services/contactPageResolveService.js';

/**
 * POST body: { urls: string[] } — homepage URLs, max 50.
 * Returns { resolved: string[] } — same length/order; each URL is /contact when probe succeeds, else original home.
 */
export async function postResolveContactUrls(req, res) {
  try {
    const body = req.body || {};
    const urls = body.urls;
    if (!Array.isArray(urls)) {
      return res.status(400).json({ error: 'urls must be an array' });
    }
    const resolved = await resolveAllContactUrls(urls);
    res.json({ resolved });
  } catch (error) {
    console.error('postResolveContactUrls error:', error);
    res.status(500).json({ error: 'Failed to resolve contact URLs' });
  }
}
