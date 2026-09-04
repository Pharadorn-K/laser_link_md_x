// backend/node/routes/systemLog.routes.js
// ============================================================
// /api/system-log/* routes
//   GET  /            -> admin only, filterable/paginated log list
//   GET  /actions      -> admin only, distinct action names (for filter dropdown)
//   POST /event        -> any authenticated user, generic client-event logger
// ============================================================
const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/requireRole');
const ctrl = require('../controllers/systemLog.controller');

router.get('/', requireRole('admin'), ctrl.listLogs);
router.get('/actions', requireRole('admin'), ctrl.listActions);
router.post('/event', requireAuth, ctrl.logClientEvent);

module.exports = router;