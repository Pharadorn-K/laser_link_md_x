// backend/node/routes/model.routes.js
// ============================================================
// /api/models/* routes
//   Reads: any authenticated user.
//   Writes: admin only. Create/Update accept multipart/form-data.
//
//   Per-piece queue moved to /api/piece-queue/* (shared by model+lot_no
//   now, not by model_condition_id) — see pieceQueue.routes.js.
//   guardVariableConditions still runs here on create/update since it
//   validates THIS row's per-piece names against its siblings.
// ============================================================
const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/requireRole');
const uploadModelPhoto = require('../middleware/uploadModelPhoto');
const ctrl = require('../controllers/model.controller');
const queueCtrl = require('../controllers/modelQueue.controller');

router.get('/condition-names', requireAuth, ctrl.listConditionNames);
router.get('/', requireAuth, ctrl.listModels);
router.get('/:id', requireAuth, ctrl.getModel);
router.post('/', requireRole('admin'), uploadModelPhoto.single('photo'), queueCtrl.guardVariableConditions, ctrl.createModel);
router.put('/:id', requireRole('admin'), uploadModelPhoto.single('photo'), queueCtrl.guardVariableConditions, ctrl.updateModel);
router.delete('/:id', requireRole('admin'), ctrl.deleteModel);
router.patch('/:id/conditions/:itemId', requireAuth, ctrl.updateConditionValue);
router.patch('/:id/lotno', requireAuth, ctrl.updateLotNo);
router.patch('/:id/camera', requireAuth, ctrl.updateCameraCheck);

module.exports = router;