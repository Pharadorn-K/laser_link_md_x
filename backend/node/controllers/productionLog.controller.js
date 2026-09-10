// backend/node/controllers/productionLog.controller.js
// ============================================================
// Production Log page controller (Admin/Engineer only).
//   getSummary -> grouped by (model, job_no, lot_no, conditions),
//                 paginated (21/page by default).
//   getRaw     -> ungrouped, one row per production_log entry,
//                 including per-row code2d_result, paginated.
//
//   Both accept EITHER:
//     ?month=YYYY-MM                (browse view, single month)
//   OR
//     ?from=YYYY-MM-DD&to=YYYY-MM-DD (arbitrary range, used by export)
//   and an optional ?all=1 to skip pagination and return every
//   matching row (used by the CSV export, which needs the full set).
// ============================================================
const pool = require('../config/db');

const DEFAULT_PAGE_SIZE = 21;
const MAX_PAGE_SIZE = 500;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function monthBounds(monthStr) {
  let year, month;
  if (monthStr && /^\d{4}-\d{2}$/.test(monthStr)) {
    [year, month] = monthStr.split('-').map(Number);
  } else {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth() + 1;
  }
  const start = `${year}-${pad2(month)}-01 00:00:00`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const end = `${nextYear}-${pad2(nextMonth)}-01 00:00:00`;
  return { start, end, label: `${year}-${pad2(month)}` };
}

// Resolves the WHERE-clause date bounds from either ?month=YYYY-MM or
// ?from=YYYY-MM-DD&to=YYYY-MM-DD. from/to take priority when present.
// `to` is treated as inclusive (bumped forward one day internally).
function resolveBounds(query) {
  const { month, from, to } = query || {};

  if (from || to) {
    const start = /^\d{4}-\d{2}-\d{2}$/.test(from) ? `${from} 00:00:00` : '1970-01-01 00:00:00';
    let end = '2999-01-01 00:00:00';
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      const d = new Date(`${to}T00:00:00`);
      d.setDate(d.getDate() + 1);
      end = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} 00:00:00`;
    }
    const label = from && to ? `${from} to ${to}` : from ? `From ${from}` : `Until ${to}`;
    return { start, end, label };
  }

  return monthBounds(month);
}

function parsePaging(query) {
  const all = query.all === '1' || query.all === 'true';
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.pageSize, 10) || DEFAULT_PAGE_SIZE));
  return { all, page, pageSize, offset: (page - 1) * pageSize };
}

function parseConditions(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function conditionsSummary(items) {
  if (!items || items.length === 0) return '—';
  return items.map((it) => `${it.condition_name}=${it.condition_value}`).join(', ');
}

// ---------------- GET /api/production-log/summary ----------------
async function getSummary(req, res) {
  const { start, end, label } = resolveBounds(req.query);
  const { all, page, pageSize, offset } = parsePaging(req.query);

  try {
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM (
         SELECT 1 FROM production_log
          WHERE marked_at >= ? AND marked_at < ?
          GROUP BY model, job_no, lot_no, CAST(conditions AS CHAR)
       ) t`,
      [start, end]
    );
    const total = countRows[0].total;

    const limitSql = all ? '' : 'LIMIT ? OFFSET ?';
    const params = all ? [start, end] : [start, end, pageSize, offset];

    const [rows] = await pool.query(
      `SELECT
          model,
          job_no,
          lot_no,
          ANY_VALUE(conditions) AS conditions,
          GROUP_CONCAT(DISTINCT CASE WHEN type = 'setting' THEN user_name END SEPARATOR ', ') AS setting_users,
          GROUP_CONCAT(DISTINCT CASE WHEN type = 'mass' THEN user_name END SEPARATOR ', ') AS mass_users,
          SUM(CASE WHEN type = 'setting' THEN 1 ELSE 0 END) AS count_setting,
          SUM(CASE WHEN type = 'mass' THEN 1 ELSE 0 END) AS count_mass,
          COUNT(*) AS total_count,
          MIN(marked_at) AS start_at,
          MAX(marked_at) AS end_at
        FROM production_log
        WHERE marked_at >= ? AND marked_at < ?
        GROUP BY model, job_no, lot_no, CAST(conditions AS CHAR)
        ORDER BY end_at DESC
        ${limitSql}`,
      params
    );

    const data = rows.map((r) => {
      const conditions = parseConditions(r.conditions);
      return {
        model: r.model,
        job_no: r.job_no,
        lot_no: r.lot_no,
        conditions,
        condition_summary: conditionsSummary(conditions),
        setting_users: r.setting_users || '—',
        mass_users: r.mass_users || '—',
        count_setting: Number(r.count_setting) || 0,
        count_mass: Number(r.count_mass) || 0,
        total_count: Number(r.total_count) || 0,
        start_at: r.start_at,
        end_at: r.end_at,
      };
    });

    return res.json({ month: label, rows: data, total, page: all ? 1 : page, pageSize: all ? total : pageSize });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error fetching production log summary.' });
  }
}

// ---------------- GET /api/production-log/raw ----------------
// One row per production_log entry — no grouping — so code2d_result
// (and who/when/which pallet) is visible for every individual count.
async function getRaw(req, res) {
  const { start, end, label } = resolveBounds(req.query);
  const { all, page, pageSize, offset } = parsePaging(req.query);

  try {
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM production_log WHERE marked_at >= ? AND marked_at < ?`,
      [start, end]
    );
    const total = countRows[0].total;

    const limitSql = all ? '' : 'LIMIT ? OFFSET ?';
    const params = all ? [start, end] : [start, end, pageSize, offset];

    const [rows] = await pool.query(
      `SELECT
          id, model, job_no, lot_no, pallet_no, type,
          user_name, employee_id, user_role,
          conditions, code2d_result, marked_at
        FROM production_log
        WHERE marked_at >= ? AND marked_at < ?
        ORDER BY marked_at DESC
        ${limitSql}`,
      params
    );

    const data = rows.map((r) => {
      const conditions = parseConditions(r.conditions);
      return {
        id: r.id,
        model: r.model,
        job_no: r.job_no,
        lot_no: r.lot_no,
        pallet_no: r.pallet_no,
        type: r.type,
        user_name: r.user_name || '—',
        employee_id: r.employee_id || null,
        user_role: r.user_role || null,
        conditions,
        condition_summary: conditionsSummary(conditions),
        code2d_result: r.code2d_result || null,
        marked_at: r.marked_at,
      };
    });

    return res.json({ month: label, rows: data, total, page: all ? 1 : page, pageSize: all ? total : pageSize });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error fetching production log detail.' });
  }
}

module.exports = { getSummary, getRaw };