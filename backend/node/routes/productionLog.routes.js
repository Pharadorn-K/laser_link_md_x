// backend/node/routes/productionLog.routes.js
// ============================================================
// /api/production-log/* routes
//   GET /summary -> admin/engineer only, monthly grouped history
// ============================================================
const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/requireRole');
const ctrl = require('../controllers/productionLog.controller');

router.get('/summary', requireRole('admin', 'engineer'), ctrl.getSummary);

module.exports = router;