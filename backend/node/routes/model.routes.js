// ============================================================
// /api/models/* routes
//   Reads: any authenticated user (Pallet boxes are visible to
//          everyone on the Model Set page).
//   Writes: admin only, same pattern as /api/users.
// ============================================================
const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/requireRole');
const ctrl = require('../controllers/model.controller');

router.get('/condition-names', requireAuth, ctrl.listConditionNames);
router.get('/', requireAuth, ctrl.listModels);
router.get('/:id', requireAuth, ctrl.getModel);
router.post('/', requireRole('admin'), ctrl.createModel);
router.put('/:id', requireRole('admin'), ctrl.updateModel);
router.delete('/:id', requireRole('admin'), ctrl.deleteModel);
router.patch('/:id/conditions/:itemId', requireAuth, ctrl.updateConditionValue);
router.patch('/:id/lotno', requireAuth, ctrl.updateLotNo);
module.exports = router;