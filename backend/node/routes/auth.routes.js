// backend/node/routes/auth.routes.js
// ============================================================
// /api/auth/* routes
// ============================================================
const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const { requireAuth } = require('../middleware/requireRole');
const ctrl = require('../controllers/auth.controller');

router.post('/signup', upload.single('photo'), ctrl.signup);
router.post('/signin', ctrl.signin);
router.post('/signout', requireAuth, ctrl.signout);
router.get('/me', requireAuth, ctrl.me);
router.put('/profile', requireAuth, upload.single('photo'), ctrl.updateProfile);

module.exports = router;