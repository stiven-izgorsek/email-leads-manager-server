import {
  assignFollowupsToEmail,
  getFollowupAssignmentLeads,
  getFollowupDashboard,
  releaseAllOrphanedFollowupRuns,
  resetFollowupDailySentCount,
  runFollowupForAll,
  runFollowupForEmail,
  setFollowupEnabled,
  startAssignFollowupsToAll,
  stopAllFollowupRuns,
  unassignAllPendingFollowupLeads,
  unassignFollowupLead,
} from '../services/followupService.js';

export async function getFollowupDashboardHandler(req, res) {
  try {
    const data = await getFollowupDashboard(req.query.date);
    res.json(data);
  } catch (error) {
    console.error('getFollowupDashboard error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

export async function assignFollowupLeads(req, res) {
  try {
    const { emailId, count, date, daysBefore } = req.body || {};
    if (!emailId) return res.status(400).json({ error: 'emailId is required' });
    const days = daysBefore ?? 7;
    const result = await assignFollowupsToEmail(emailId, count, date, days);
    res.json(result);
  } catch (error) {
    console.error('assignFollowupLeads error:', error);
    const msg = error.message || 'Internal server error';
    const status = /not found|not eligible|Cannot assign|Nylas|required/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
}

export async function assignFollowupLeadsAll(req, res) {
  try {
    const { countPerAccount, date, daysBefore } = req.body || {};
    const result = startAssignFollowupsToAll(countPerAccount, date, daysBefore ?? 7);
    res.json(result);
  } catch (error) {
    console.error('assignFollowupLeadsAll error:', error);
    const msg = error.message || 'Internal server error';
    res.status(/already in progress/i.test(msg) ? 409 : 500).json({ error: msg });
  }
}

export async function startFollowupForEmail(req, res) {
  try {
    const { emailId } = req.params;
    const { date } = req.body || {};
    const result = await runFollowupForEmail(emailId, date);
    res.json(result);
  } catch (error) {
    console.error('startFollowupForEmail error:', error);
    const msg = error.message || 'Internal server error';
    const status = /not found|not eligible|already running|Assign/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
}

export async function startFollowupForAll(req, res) {
  try {
    const { date } = req.body || {};
    const result = await runFollowupForAll(date);
    res.json(result);
  } catch (error) {
    console.error('startFollowupForAll error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

export async function setFollowupEnabledHandler(req, res) {
  try {
    const { emailId } = req.params;
    const { followupEnabled } = req.body || {};
    if (followupEnabled === undefined) {
      return res.status(400).json({ error: 'followupEnabled is required' });
    }
    const result = await setFollowupEnabled(emailId, followupEnabled);
    res.json(result);
  } catch (error) {
    console.error('setFollowupEnabled error:', error);
    const msg = error.message || 'Internal server error';
    res.status(/not found|required/i.test(msg) ? 400 : 500).json({ error: msg });
  }
}

export async function getFollowupAssignmentLeadsHandler(req, res) {
  try {
    const { emailId } = req.params;
    const result = await getFollowupAssignmentLeads(emailId, req.query.date);
    res.json(result);
  } catch (error) {
    console.error('getFollowupAssignmentLeads error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

export async function unassignFollowupLeadHandler(req, res) {
  try {
    const result = await unassignFollowupLead(req.params.assignmentLeadId);
    res.json(result);
  } catch (error) {
    console.error('unassignFollowupLead error:', error);
    res.status(400).json({ error: error.message || 'Internal server error' });
  }
}

export async function unassignAllPendingFollowupLeadsHandler(req, res) {
  try {
    const { date, emailId } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date is required' });
    const result = await unassignAllPendingFollowupLeads({ assignmentDate: date, emailId });
    res.json(result);
  } catch (error) {
    console.error('unassignAllPendingFollowupLeads error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

export async function resetFollowupDailySentHandler(req, res) {
  try {
    const { date, emailId } = req.body || {};
    if (!date) return res.status(400).json({ error: 'date is required' });
    const result = await resetFollowupDailySentCount(date, emailId || null);
    res.json(result);
  } catch (error) {
    console.error('resetFollowupDailySent error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

export async function stopAllFollowupRunsHandler(req, res) {
  try {
    const { date } = req.body || {};
    const result = await stopAllFollowupRuns(date);
    res.json(result);
  } catch (error) {
    console.error('stopAllFollowupRuns error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

export async function releaseStuckFollowupRunsHandler(req, res) {
  try {
    const released = await releaseAllOrphanedFollowupRuns('manual reset');
    res.json({
      released,
      message:
        released > 0
          ? `Cleared ${released} stuck follow-up flag(s). Refresh and start again.`
          : 'No stuck follow-up flags found.',
    });
  } catch (error) {
    console.error('releaseStuckFollowupRuns error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
