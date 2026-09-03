import {
  assignLeadsToAll,
  assignLeadsToEmail,
  getAssignmentLeadsForEmail,
  getMarketingDashboard,
  releaseAllOrphanedMarketingRuns,
  runMarketingForAll,
  runMarketingForEmail,
  setMarketingEnabled,
  setMarketingAssignDefault,
  stopMarketingForEmail,
  unassignMarketingLead,
  unassignAllPendingMarketingLeads,
  resetDailySentCount,
  retryFailedMarketingLead,
  retryFailedMarketingLeads,
} from '../services/marketingService.js';
import {
  listPendingDomainBlockAlerts,
  dismissDomainBlockAlert,
  confirmStopForDomainBlockAlert,
} from '../services/domainBlockAlertService.js';
import { isAppPasswordFeaturesEnabled } from '../services/smtpSendService.js';

function rejectSmtpIfDisabled(res, channel) {
  if (channel === 'smtp' && !isAppPasswordFeaturesEnabled()) {
    res.status(503).json({
      error:
        'SMTP / App Password marketing is temporarily disabled (APP_PASSWORD_FEATURES_ENABLED=false)',
    });
    return true;
  }
  return false;
}

export async function getMarketingDashboardHandler(req, res) {
  try {
    const channel =
      req.query.channel === 'smtp'
        ? 'smtp'
        : req.query.channel === 'any'
          ? 'any'
          : 'nylas';
    if (rejectSmtpIfDisabled(res, channel)) return;
    const nylasOnly =
      channel === 'nylas'
        ? req.query.nylasOnly === 'false' || req.query.nylasOnly === '0'
          ? false
          : true
        : false;
    const data = await getMarketingDashboard(req.query.date, { nylasOnly, channel });
    const runningCount = (data.rows || []).filter((r) => r.running).length;
    if (runningCount > 0) {
      console.log(
        `[marketing] GET dashboard date=${data.assignmentDate} channel=${data.channel}: ${runningCount} mailbox(es) marked running in DB`
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
    const { emailId, count, date, leadFilterId, leadFilterIds, leadFilterMode, channel } =
      req.body || {};
    if (!emailId) return res.status(400).json({ error: 'emailId is required' });
    const resolvedChannel = channel === 'smtp' ? 'smtp' : 'nylas';
    if (rejectSmtpIfDisabled(res, resolvedChannel)) return;
    const result = await assignLeadsToEmail(emailId, count, date, {
      leadFilterId,
      leadFilterIds,
      leadFilterMode,
      channel: resolvedChannel,
    });
    res.json(result);
  } catch (error) {
    console.error('assignMarketingLeads error:', error);
    const msg = error.message || 'Internal server error';
    const status = /not found|not eligible|Cannot assign|Nylas|App Password/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
}

export async function assignMarketingLeadsAll(req, res) {
  try {
    const {
      countPerAccount,
      date,
      leadFilterId,
      leadFilterIds,
      leadFilterMode,
      channel,
      continent,
      assignFraction,
    } = req.body || {};
    const resolvedChannel = channel === 'smtp' ? 'smtp' : 'nylas';
    if (rejectSmtpIfDisabled(res, resolvedChannel)) return;
    const result = await assignLeadsToAll(countPerAccount, date, {
      leadFilterId,
      leadFilterIds,
      leadFilterMode,
      channel: resolvedChannel,
      continent,
      assignFraction,
      includeOooReplied: Boolean(req.body?.includeOooReplied),
      oooMix: req.body?.oooMix,
      includeUsedLeads: Boolean(req.body?.includeUsedLeads),
      usedMix: req.body?.usedMix,
      priorityCountries: req.body?.priorityCountries,
    });
    res.json(result);
  } catch (error) {
    console.error('assignMarketingLeadsAll error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

export async function startMarketingForEmail(req, res) {
  try {
    const { emailId } = req.params;
    const { date, channel } = req.body || {};
    const resolvedChannel = channel === 'smtp' ? 'smtp' : 'nylas';
    if (rejectSmtpIfDisabled(res, resolvedChannel)) return;
    console.log(
      `[marketing] API POST /start/${emailId} date=${date || 'today'} channel=${resolvedChannel}`
    );
    const result = await runMarketingForEmail(emailId, date, {
      channel: resolvedChannel,
    });
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

export async function setMarketingAssignDefaultHandler(req, res) {
  try {
    const { emailId } = req.params;
    const { assignDefault, marketingAssignDefault } = req.body || {};
    const value = assignDefault ?? marketingAssignDefault;
    if (value === undefined) {
      return res.status(400).json({ error: 'assignDefault is required' });
    }
    const result = await setMarketingAssignDefault(emailId, value);
    res.json(result);
  } catch (error) {
    console.error('setMarketingAssignDefault error:', error);
    const msg = error.message || 'Internal server error';
    const status = /not found|must be between/i.test(msg) ? 400 : 500;
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

export async function retryFailedMarketingLeadHandler(req, res) {
  try {
    const { assignmentLeadId } = req.params;
    const { start, channel } = req.body || {};
    const resolvedChannel = channel === 'smtp' ? 'smtp' : 'nylas';
    if (rejectSmtpIfDisabled(res, resolvedChannel)) return;
    const result = await retryFailedMarketingLead(assignmentLeadId, {
      start: start !== false,
      channel: resolvedChannel,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('retryFailedMarketingLead error:', error);
    const msg = error.message || 'Internal server error';
    const status = /not found|Only failed/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
}

export async function retryFailedMarketingLeadsHandler(req, res) {
  try {
    const { date, emailId, start, channel } = req.body || {};
    if (!date) {
      return res.status(400).json({ error: 'date is required' });
    }
    const resolvedChannel = channel === 'smtp' ? 'smtp' : 'nylas';
    if (rejectSmtpIfDisabled(res, resolvedChannel)) return;
    const result = await retryFailedMarketingLeads({
      assignmentDate: date,
      emailId: emailId || undefined,
      start: start !== false,
      channel: resolvedChannel,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('retryFailedMarketingLeads error:', error);
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
    const { date, channel } = req.body || {};
    const resolvedChannel = channel === 'smtp' ? 'smtp' : 'nylas';
    if (rejectSmtpIfDisabled(res, resolvedChannel)) return;
    console.log(
      `[marketing] API POST /start-all date=${date || 'today'} channel=${resolvedChannel}`
    );
    const result = await runMarketingForAll(date, {
      channel: resolvedChannel,
    });
    console.log('[marketing] API POST /start-all response', {
      started: result.started,
      skipped: result.skipped,
      concurrency: result.concurrency,
      channel: result.channel,
    });
    res.json(result);
  } catch (error) {
    console.error('startMarketingForAll error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

export async function stopMarketingForEmailHandler(req, res) {
  try {
    const { emailId } = req.params;
    const { date } = req.body || {};
    const result = await stopMarketingForEmail(emailId, date);
    res.json(result);
  } catch (error) {
    console.error('stopMarketingForEmail error:', error);
    const msg = error.message || 'Internal server error';
    const status = /required|not found/i.test(msg) ? 400 : 500;
    res.status(status).json({ error: msg });
  }
}

export async function listDomainBlockAlertsHandler(req, res) {
  try {
    const alerts = await listPendingDomainBlockAlerts();
    res.json({ alerts });
  } catch (error) {
    console.error('listDomainBlockAlerts error:', error);
    res.status(500).json({ error: error.message || 'Internal server error' });
  }
}

export async function dismissDomainBlockAlertHandler(req, res) {
  try {
    const { id } = req.params;
    const alert = await dismissDomainBlockAlert(id);
    res.json({ alert });
  } catch (error) {
    console.error('dismissDomainBlockAlert error:', error);
    const msg = error.message || 'Internal server error';
    const status = /not found/i.test(msg) ? 404 : 500;
    res.status(status).json({ error: msg });
  }
}

export async function confirmDomainBlockAlertHandler(req, res) {
  try {
    const { id } = req.params;
    const { date } = req.body || {};
    const result = await confirmStopForDomainBlockAlert(id, date);
    res.json(result);
  } catch (error) {
    console.error('confirmDomainBlockAlert error:', error);
    const msg = error.message || 'Internal server error';
    const status = /not found/i.test(msg) ? 404 : 500;
    res.status(status).json({ error: msg });
  }
}
