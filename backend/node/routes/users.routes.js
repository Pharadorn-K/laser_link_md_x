// ============================================================
// /api/users/* routes  (admin only — user approval / role mgmt)
// ============================================================
const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/requireRole');
const ctrl = require('../controllers/auth.controller');

router.get('/', requireRole('admin'), ctrl.listUsers);
router.patch('/:id/status', requireRole('admin'), ctrl.setUserStatus);
router.patch('/:id/role', requireRole('admin'), ctrl.setUserRole);

module.exports = router;
