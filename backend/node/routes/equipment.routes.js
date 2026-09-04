// backend/node/routes/equipment.routes.js
// ============================================================
// /api/equipment/* routes  (admin/engineer only)
// Thin proxy: every call is forwarded 1:1 to the Python service.
// State-changing calls (test connection, raw/command send, queue
// add/clear) are also recorded to system_log for admin traceability.
// ============================================================
const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/requireRole');
const laser = require('../services/laserService');
const systemLog = require('../services/systemLog.service');

const guard = requireRole('admin', 'engineer');

function okStatus(status) {
  return status >= 200 && status < 300 ? 'success' : 'failed';
}

router.get('/commands', guard, async (req, res) => {
  const r = await laser.forward('get', '/api/commands');
  res.status(r.status).json(r.data);
});

router.get('/status', guard, async (req, res) => {
  const r = await laser.forward('get', '/api/status');
  res.status(r.status).json(r.data);
});

router.post('/connect', guard, async (req, res) => {
  const { ip, port } = req.body || {};
  const r = await laser.forward('post', '/api/connect', req.body);
  await systemLog.logAction({
    req,
    action: 'equipment.test_connection',
    targetType: 'equipment',
    description: `Tested connection to ${ip}:${port}`,
    details: { ip, port, response: r.data },
    status: okStatus(r.status),
  });
  res.status(r.status).json(r.data);
});

router.post('/raw', guard, async (req, res) => {
  const { command } = req.body || {};
  const r = await laser.forward('post', '/api/raw', req.body);
  await systemLog.logAction({
    req,
    action: 'equipment.raw_command',
    targetType: 'equipment',
    description: `Sent raw command: ${command}`,
    details: { command, response: r.data },
    status: okStatus(r.status),
  });
  res.status(r.status).json(r.data);
});

router.post('/command', guard, async (req, res) => {
  const { command } = req.body || {};
  const r = await laser.forward('post', '/api/command', req.body);
  await systemLog.logAction({
    req,
    action: 'equipment.command',
    targetType: 'equipment',
    description: `Sent command: ${command}`,
    details: { command, response: r.data },
    status: okStatus(r.status),
  });
  res.status(r.status).json(r.data);
});

router.get('/queue', guard, async (req, res) => {
  const r = await laser.forward('get', '/api/queue');
  res.status(r.status).json(r.data);
});

router.post('/queue', guard, async (req, res) => {
  const { program_no } = req.body || {};
  const r = await laser.forward('post', '/api/queue', req.body);
  await systemLog.logAction({
    req,
    action: 'equipment.queue_add',
    targetType: 'equipment',
    description: `Queued job ${program_no}`,
    details: { program_no, response: r.data },
    status: okStatus(r.status),
  });
  res.status(r.status).json(r.data);
});

router.delete('/queue/:id', guard, async (req, res) => {
  const r = await laser.forward('delete', `/api/queue/${req.params.id}`);
  await systemLog.logAction({
    req,
    action: 'equipment.queue_remove',
    targetType: 'equipment',
    description: `Removed queue job ${req.params.id}`,
    status: okStatus(r.status),
  });
  res.status(r.status).json(r.data);
});

router.delete('/queue', guard, async (req, res) => {
  const r = await laser.forward('delete', '/api/queue');
  await systemLog.logAction({
    req,
    action: 'equipment.queue_clear',
    targetType: 'equipment',
    description: 'Cleared pending job queue',
    status: okStatus(r.status),
  });
  res.status(r.status).json(r.data);
});

module.exports = router;