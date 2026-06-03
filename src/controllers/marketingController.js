import {
  assignLeadsToAll,
  assignLeadsToEmail,
  getAssignmentLeadsForEmail,
  getMarketingDashboard,
  releaseAllOrphanedMarketingRuns,
  runMarketingForAll,
  runMarketingForEmail,
  setMarketingEnabled,
  unassignMarketingLead,
  unassignAllPendingMarketingLeads,
  resetDailySentCount,
} from '../services/marketingService.js';

export async function getMarketingDashboardHandler(req, res) {
  try {
    const nylasOnly =
      req.query.nylasOnly === 'false' || req.query.nylasOnly === '0'
        ? false
        : true;
    const data = await getMarketingDashboard(req.query.date, { nylasOnly });
    const runningCount = (data.rows || []).filter((r) => r.running).length;
    if (runningCount > 0) {
      console.log(
        `[marketing] GET dashboard date=${data.assignmentDate}: ${runningCount} mailbox(es) marked running in DB`
      );
    }
    res.json(data);
  } catch (error) {
    console.error('getMarketingDashboard error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

export async function assignMarketingLeads(req, res) {
  try {
    const { emailId, count, date } = req.body || {};
    if (!emailId) return res.status(400).json({ error: 'emailId is required' });
    const result = await assignLeadsToEmail(emailId, count, date);
    res.json(result);
  } catch (error) {
    console.error('assignMarketingLeads error:', error);
    const msg = error.message || 'Internal server error';
    const status = /not found|not eligible|Cannot assign|Nylas/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
}

export async function assignMarketingLeadsAll(req, res) {
  try {
    const { countPerAccount, date } = req.body || {};
    const result = await assignLeadsToAll(countPerAccount, date);
    res.json(result);
  } catch (error) {
    console.error('assignMarketingLeadsAll error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

export async function startMarketingForEmail(req, res) {
  try {
    const { emailId } = req.params;
    const { date } = req.body || {};
    console.log(`[marketing] API POST /start/${emailId} date=${date || 'today'}`);
    const result = await runMarketingForEmail(emailId, date);
    res.json(result);
  } catch (error) {
    console.error('startMarketingForEmail error:', error);
    const msg = error.message || 'Internal server error';
    const status = /not found|not eligible|already running|Assign leads/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
}

export async function setMarketingEnabledHandler(req, res) {
  try {
    const { emailId } = req.params;
    const { marketingEnabled } = req.body || {};
    if (marketingEnabled === undefined) {
      return res.status(400).json({ error: 'marketingEnabled is required' });
    }
    const result = await setMarketingEnabled(emailId, marketingEnabled);
    res.json(result);
  } catch (error) {
    console.error('setMarketingEnabled error:', error);
    const msg = error.message || 'Internal server error';
    const status = /not found|required/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
}

export async function getAssignmentLeadsHandler(req, res) {
  try {
    const { emailId } = req.params;
    const result = await getAssignmentLeadsForEmail(emailId, req.query.date);
    res.json(result);
  } catch (error) {
    console.error('getAssignmentLeads error:', error);
    const msg = error.message || 'Internal server error';
    const status = /not found/i.test(msg) ? 404 : 500;
    res.status(status).json({ error: msg });
  }
}

export async function unassignMarketingLeadHandler(req, res) {
  try {
    const { assignmentLeadId } = req.params;
    const result = await unassignMarketingLead(assignmentLeadId);
    res.json(result);
  } catch (error) {
    console.error('unassignMarketingLead error:', error);
    const msg = error.message || 'Internal server error';
    const status = /not found|Only pending/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
}

export async function unassignAllPendingMarketingLeadsHandler(req, res) {
  try {
    const { date, emailId } = req.body || {};
    if (!date) {
      return res.status(400).json({ error: 'date is required' });
    }
    const result = await unassignAllPendingMarketingLeads({
      assignmentDate: date,
      emailId: emailId || undefined,
    });
    res.json(result);
  } catch (error) {
    console.error('unassignAllPendingMarketingLeads error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

export async function releaseStuckMarketingRunsHandler(req, res) {
  try {
    const released = await releaseAllOrphanedMarketingRuns('manual reset');
    res.json({
      released,
      message:
        released > 0
          ? `Cleared ${released} stuck running flag(s). Refresh the page, then click Start all again.`
          : 'No stuck running flags found.',
    });
  } catch (error) {
    console.error('releaseStuckMarketingRuns error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

export async function resetDailySentCountHandler(req, res) {
  try {
    const { date, emailId } = req.body || {};
    if (!date) {
      return res.status(400).json({ error: 'date is required' });
    }
    const result = await resetDailySentCount(date, emailId || null);
    res.json(result);
  } catch (error) {
    console.error('resetDailySentCount error:', error);
    const msg = error.message || 'Internal server error';
    const status = /not found/i.test(msg) ? 404 : 500;
    res.status(status).json({ error: msg });
  }
}

export async function startMarketingForAll(req, res) {
  try {
    const { date } = req.body || {};
    console.log(`[marketing] API POST /start-all date=${date || 'today'}`);
    const result = await runMarketingForAll(date);
    console.log('[marketing] API POST /start-all response', {
      started: result.started,
      skipped: result.skipped,
      concurrency: result.concurrency,
    });
    res.json(result);
  } catch (error) {
    console.error('startMarketingForAll error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
