// backend/node/routes/io.routes.js
// ============================================================
// /api/io/* — proxies to the Python Modbus I/O bridge (io_service.py).
//
// Open to ALL signed-in roles, including operator: the Monitor
// auto-cycle (Close Front Door -> Change Pallet -> Open Front Door,
// plus side-door / pallet-position sensor reads) runs as the operator.
// These endpoints only expose fixed actions; the real safety
// interlocks (side door, front door closed, pallet alarms, position
// preconditions) are enforced in io_core.py, not by the role.
// State-changing calls are logged to system_log.
//
// Deliberately NOT exposed here: alarm-reset and swap-pallets.
// ============================================================
const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/requireRole');
const io = require('../services/ioService');
const systemLog = require('../services/systemLog.service');

const guard = requireRole('admin', 'engineer', 'machine_controller', 'operator');

function okStatus(status) {
  return status >= 200 && status < 300 ? 'success' : 'failed';
}

router.get('/status', guard, async (req, res) => {
  const r = await io.forward('get', '/api/io/status');
  res.status(r.status).json(r.data);
});

router.post('/front-door', guard, async (req, res) => {
  const { action } = req.body || {};
  const r = await io.forward('post', '/api/io/front-door', req.body);
  await systemLog.logAction({
    req,
    action: 'io.front_door',
    targetType: 'io',
    description: `Front door: ${action}`,
    details: { action, response: r.data },
    status: okStatus(r.status),
  });
  res.status(r.status).json(r.data);
});

router.post('/call-pallet/:palletNo', guard, async (req, res) => {
  const { palletNo } = req.params;
  const r = await io.forward('post', `/api/io/call-pallet/${palletNo}`, req.body);
  await systemLog.logAction({
    req,
    action: 'io.call_pallet',
    targetType: 'io',
    description: `Call pallet ${palletNo}`,
    details: { palletNo, response: r.data },
    status: okStatus(r.status),
  });
  res.status(r.status).json(r.data);
});

router.post('/change-pallet', guard, async (req, res) => {
  const { target_pallet } = req.body || {};
  const r = await io.forward('post', '/api/io/change-pallet', req.body);
  await systemLog.logAction({
    req,
    action: 'io.change_pallet',
    targetType: 'io',
    description: `Change pallet -> ${target_pallet}`,
    details: { target_pallet, response: r.data },
    status: okStatus(r.status),
  });
  res.status(r.status).json(r.data);
});

module.exports = router;