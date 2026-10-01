// backend/node/routes/pieceQueue.routes.js
// ============================================================
// /api/piece-queue/* — shared per-piece queue, keyed by (model, lot_no)
//   GET    /              any authenticated user   ?model=&lot_no=
//   POST   /import        admin / engineer          {model, lot_no, columns, rows, dry_run}
//   DELETE /              admin / engineer          ?model=&lot_no=
//   POST   /reserve       any authenticated user     {model, lot_no, model_condition_id, pallet_no}
//   POST   /:queueId/release  any authenticated user
//   POST   /:queueId/fail     any authenticated user
// ============================================================
const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/requireRole');
const ctrl = require('../controllers/modelQueue.controller');

const writeGuard = requireRole('admin', 'engineer');

router.get('/', requireAuth, ctrl.getQueue);
router.post('/import', writeGuard, ctrl.importQueue);
router.delete('/', writeGuard, ctrl.clearQueue);

router.post('/reserve', requireAuth, ctrl.reserveNext);
router.post('/:queueId/release', requireAuth, ctrl.releaseReserved);
router.post('/:queueId/fail', requireAuth, ctrl.failReserved);

module.exports = router;