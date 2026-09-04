// backend/node/services/systemLog.service.js
// ============================================================
// Central write-path for the System Log. Every controller that
// performs a trackable action (create/edit/delete, sign-in/up/out,
// approvals, mode changes, equipment tests) calls logAction().
// Logging failures are swallowed — a broken log write must never
// break the actual request the user is waiting on.
// ============================================================
const pool = require('../config/db');

function getClientIp(req) {
  if (!req) return null;
  const xf = req.headers && req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.ip || (req.connection && req.connection.remoteAddress) || null;
}

/**
 * @param {object} opts
 * @param {object} [opts.req]         - express req, used for IP + fallback actor (req.user)
 * @param {object} [opts.user]        - explicit actor {id, employee_id, name, role} overrides req.user
 * @param {string} opts.action        - e.g. 'model.create', 'auth.signin'
 * @param {string} [opts.targetType]  - e.g. 'model_condition', 'user', 'equipment'
 * @param {string|number} [opts.targetId]
 * @param {string} [opts.description] - short human-readable summary
 * @param {object} [opts.details]     - JSON-serializable extra context (before/after, params, etc.)
 * @param {'success'|'failed'} [opts.status]
 */
async function logAction({
  req,
  user,
  action,
  targetType = null,
  targetId = null,
  description = null,
  details = null,
  status = 'success',
}) {
  try {
    if (!action) return;
    const actor = user || (req && req.user) || null;

    await pool.query(
      `INSERT INTO system_log
        (user_id, employee_id, user_name, user_role, action, target_type, target_id, description, details, status, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actor ? actor.id ?? null : null,
        actor ? actor.employee_id ?? null : null,
        actor ? actor.name ?? null : null,
        actor ? actor.role ?? null : null,
        String(action).slice(0, 64),
        targetType ? String(targetType).slice(0, 64) : null,
        targetId != null ? String(targetId).slice(0, 64) : null,
        description ? String(description).slice(0, 500) : null,
        details ? JSON.stringify(details) : null,
        status === 'failed' ? 'failed' : 'success',
        getClientIp(req),
      ]
    );
  } catch (err) {
    console.error('[systemLog] failed to write log entry:', err.message);
  }
}

module.exports = { logAction };