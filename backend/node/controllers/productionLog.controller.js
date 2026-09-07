// backend/node/controllers/productionLog.controller.js
// ============================================================
// Production Log page controller (Admin/Engineer only).
// Groups production_log rows by (model, job_no, lot_no, conditions)
// for a given month and returns setting/mass split counts.
// ============================================================
const pool = require('../config/db');

function monthBounds(monthStr) {
  let year, month;
  if (monthStr && /^\d{4}-\d{2}$/.test(monthStr)) {
    [year, month] = monthStr.split('-').map(Number);
  } else {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth() + 1;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const start = `${year}-${pad(month)}-01 00:00:00`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const end = `${nextYear}-${pad(nextMonth)}-01 00:00:00`;
  return { start, end, label: `${year}-${pad(month)}` };
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

// ---------------- GET /api/production-log/summary?month=YYYY-MM ----------------
async function getSummary(req, res) {
  const { month } = req.query;
  const { start, end, label } = monthBounds(month);

  try {
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
        ORDER BY end_at DESC`,
      [start, end]
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

    return res.json({ month: label, rows: data });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error fetching production log summary.' });
  }
}

module.exports = { getSummary };