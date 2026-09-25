// backend/node/routes/model.routes.js
// ============================================================
// /api/models/* routes
//   Reads: any authenticated user (Pallet boxes are visible to
//          everyone on the Model Set page).
//   Writes: admin only. Create/Update accept multipart/form-data
//           (photo is optional) instead of plain JSON.
//
//   Per-piece queue (special-case marking):
//     GET    /:id/queue          any authenticated user (Monitor needs it)
//     POST   /:id/queue/import   admin / engineer  (CSV -> replaces queue)
//     DELETE /:id/queue          admin / engineer
// ============================================================
const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/requireRole');
const uploadModelPhoto = require('../middleware/uploadModelPhoto');
const ctrl = require('../controllers/model.controller');
const queueCtrl = require('../controllers/modelQueue.controller');

const queueWriteGuard = requireRole('admin', 'engineer');

router.get('/condition-names', requireAuth, ctrl.listConditionNames);
router.get('/', requireAuth, ctrl.listModels);
router.get('/:id', requireAuth, ctrl.getModel);
router.post('/', requireRole('admin'), uploadModelPhoto.single('photo'), queueCtrl.guardVariableConditions, ctrl.createModel);
router.put('/:id', requireRole('admin'), uploadModelPhoto.single('photo'), queueCtrl.guardVariableConditions, ctrl.updateModel);
router.delete('/:id', requireRole('admin'), ctrl.deleteModel);
router.patch('/:id/conditions/:itemId', requireAuth, ctrl.updateConditionValue);
router.patch('/:id/lotno', requireAuth, ctrl.updateLotNo);
router.patch('/:id/camera', requireAuth, ctrl.updateCameraCheck);

router.get('/:id/queue', requireAuth, queueCtrl.getQueue);
router.post('/:id/queue/import', queueWriteGuard, queueCtrl.importQueue);
router.delete('/:id/queue', queueWriteGuard, queueCtrl.clearQueue);

module.exports = router;