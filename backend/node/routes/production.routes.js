// backend/node/routes/production.routes.js
// ============================================================
// /api/production/* routes
//   GET  /count            -> any authenticated user
//   GET  /timings          -> any authenticated user
//   GET  /my-summary        -> any authenticated user (own stats/recent/trend)
//   POST /log              -> any authenticated user
//   POST /reset            -> admin/engineer/machine_controller only
//   GET  /setting-summary   -> admin/engineer/machine_controller only
//   POST /complete-setting  -> admin/engineer/machine_controller only
// ============================================================
const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/requireRole');
const ctrl = require('../controllers/production.controller');

const settingGuard = requireRole('admin', 'engineer', 'machine_controller');

router.get('/count', requireAuth, ctrl.getCount);
router.get('/timings', requireAuth, ctrl.getTimings);
router.get('/my-summary', requireAuth, ctrl.getMySummary); // NEW
router.post('/log', requireAuth, ctrl.logProduction);
router.post('/reset', settingGuard, ctrl.resetCount);
router.get('/setting-summary', settingGuard, ctrl.getSettingSummary);
router.post('/complete-setting', settingGuard, ctrl.completeSetting);

module.exports = router;