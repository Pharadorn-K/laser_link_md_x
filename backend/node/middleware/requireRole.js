// backend/node/middleware/requireRole.js
// ============================================================
// Auth middleware
//   requireAuth        -> verifies JWT, attaches req.user
//   requireRole(...roles) -> requireAuth + checks req.user.role
// ============================================================
const jwt = require('jsonwebtoken');
require('dotenv').config();

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing authentication token.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, employee_id, name, role, status }
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function requireRole(...roles) {
  return function (req, res, next) {
    requireAuth(req, res, function () {
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Insufficient permissions.' });
      }
      return next();
    });
  };
}

module.exports = { requireAuth, requireRole };
