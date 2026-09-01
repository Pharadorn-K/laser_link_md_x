// backend/node/routes/equipment.routes.js
// ============================================================
// /api/equipment/* routes  (admin only)
// Thin proxy: every call is forwarded 1:1 to the Python service.
// ============================================================
const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/requireRole');
const laser = require('../services/laserService');

const guard = requireRole('admin', 'engineer');

router.get('/commands', guard, async (req, res) => {
  const r = await laser.forward('get', '/api/commands');
  res.status(r.status).json(r.data);
});

router.get('/status', guard, async (req, res) => {
  const r = await laser.forward('get', '/api/status');
  res.status(r.status).json(r.data);
});

router.post('/connect', guard, async (req, res) => {
  const r = await laser.forward('post', '/api/connect', req.body);
  res.status(r.status).json(r.data);
});

router.post('/raw', guard, async (req, res) => {
  const r = await laser.forward('post', '/api/raw', req.body);
  res.status(r.status).json(r.data);
});

router.post('/command', guard, async (req, res) => {
  const r = await laser.forward('post', '/api/command', req.body);
  res.status(r.status).json(r.data);
});

router.get('/queue', guard, async (req, res) => {
  const r = await laser.forward('get', '/api/queue');
  res.status(r.status).json(r.data);
});

router.post('/queue', guard, async (req, res) => {
  const r = await laser.forward('post', '/api/queue', req.body);
  res.status(r.status).json(r.data);
});

router.delete('/queue/:id', guard, async (req, res) => {
  const r = await laser.forward('delete', `/api/queue/${req.params.id}`);
  res.status(r.status).json(r.data);
});

router.delete('/queue', guard, async (req, res) => {
  const r = await laser.forward('delete', '/api/queue');
  res.status(r.status).json(r.data);
});

module.exports = router;
