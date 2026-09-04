// backend/node/controllers/systemLog.controller.js
// ============================================================
// Read side (admin-only listing/filtering) + the generic
// client-event endpoint used for actions that have no other
// backend call to hang the log entry off of (e.g. work-mode
// change, which today is purely client-side/localStorage).
// ============================================================
const pool = require('../config/db');
const systemLog = require('../services/systemLog.service');

const MAX_PAGE_SIZE = 200;

function parseDetails(row) {
  if (!row.details) return { ...row, details: null };
  try {
    return { ...row, details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details };
  } catch (e) {
    return { ...row, details: null };
  }
}

async function listLogs(req, res) {
  const {
    action, status, user_id, employee_id, q,
    from, to,
    page = '1', pageSize = '50',
  } = req.query;

  const where = [];
  const params = [];

  if (action) { where.push('action = ?'); params.push(action); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (user_id) { where.push('user_id = ?'); params.push(user_id); }
  if (employee_id) { where.push('employee_id = ?'); params.push(employee_id); }
  if (from) { where.push('created_at >= ?'); params.push(from); }
  if (to) { where.push('created_at <= ?'); params.push(to); }
  if (q) {
    where.push('(description LIKE ? OR user_name LIKE ? OR employee_id LIKE ? OR action LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(pageSize, 10) || 50));
  const offset = (pageNum - 1) * size;

  try {
    const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM system_log ${whereSql}`, params);
    const total = countRows[0].total;

    const [rows] = await pool.query(
      `SELECT * FROM system_log ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, size, offset]
    );

    return res.json({
      rows: rows.map(parseDetails),
      total,
      page: pageNum,
      pageSize: size,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error fetching system log.' });
  }
}

// Distinct actions seen so far — populates the filter dropdown.
async function listActions(req, res) {
  const [rows] = await pool.query('SELECT DISTINCT action FROM system_log ORDER BY action ASC');
  return res.json(rows.map((r) => r.action));
}

// Generic endpoint for client-originated events with no other
// backend call to attach to (e.g. work-mode change).
async function logClientEvent(req, res) {
  const { action, description, target_type, target_id, details } = req.body || {};
  if (!action) {
    return res.status(400).json({ error: 'action is required.' });
  }
  await systemLog.logAction({
    req,
    action,
    targetType: target_type || null,
    targetId: target_id || null,
    description: description || null,
    details: details || null,
    status: 'success',
  });
  return res.json({ logged: true });
}

module.exports = { listLogs, listActions, logClientEvent };