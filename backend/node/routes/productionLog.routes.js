// backend/node/routes/productionLog.routes.js
// ============================================================
// /api/production-log/* routes
//   GET /summary -> admin/engineer only, monthly grouped history
//   GET /raw     -> admin/engineer only, monthly ungrouped rows
//                    (includes per-row code2d_result)
// ============================================================
const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/requireRole');
const ctrl = require('../controllers/productionLog.controller');

const guard = requireRole('admin', 'engineer');

router.get('/summary', guard, ctrl.getSummary);
router.get('/raw', guard, ctrl.getRaw);

module.exports = router;