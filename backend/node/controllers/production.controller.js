// backend/node/controllers/production.controller.js
// ============================================================
// Production count controller.
//   - production_log is append-only: never edited/deleted.
//   - production_count_reset holds, per (model_condition_id, lot_no),
//     a reset_at timestamp + base_count. The displayed count is:
//       base_count + COUNT(production_log rows marked_at > reset_at)
//   - Plain "Reset Count"    -> base_count = 0, reason='manual_reset'
//   - "Complete Setting"     -> base_count = <admin-entered number>,
//                                reason='setting_complete'
//     Both just move the reset stamp forward; history is preserved.
//   - "Continue Lot" (NEW)   -> carries the 'setting_complete' status
//                                forward onto a NEW lot_no, but ONLY if
//                                the OLD lot_no already had it. Used by
//                                the "Continuous" Next-Step flow so
//                                operators don't get blocked re-running
//                                Complete Setting for a lot swap that
//                                isn't a real new setup.
//   - production_goal holds a shared target per (model, lot_no) — this
//     lets AUTO1-2 (same model, two different job_no's on Pallet1 /
//     Pallet2) share ONE combined target instead of one per pallet.
//   - Mass-production logging (role = operator) is gated on TWO things:
//       1. isSettingComplete() for (model_condition_id, lot_no)
//       2. a production_goal row with a non-null goal_count exists for
//          (model, lot_no) — operators must not be able to start mass
//          production with no target set.
// ============================================================
const pool = require('../config/db');
const systemLog = require('../services/systemLog.service');

const RESET_EPOCH = '1970-01-01 00:00:00';

async function resolveModel(modelConditionId) {
  const [rows] = await pool.query('SELECT * FROM model_condition WHERE id = ?', [modelConditionId]);
  return rows.length ? rows[0] : null;
}

async function getResetInfo(modelConditionId, lotNo) {
  const [rows] = await pool.query(
    'SELECT reset_at, base_count FROM production_count_reset WHERE model_condition_id = ? AND lot_no = ?',
    [modelConditionId, lotNo]
  );
  return rows.length ? rows[0] : { reset_at: RESET_EPOCH, base_count: 0 };
}

async function computeCount(modelConditionId, lotNo) {
  const { reset_at, base_count } = await getResetInfo(modelConditionId, lotNo);
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM production_log
      WHERE model_condition_id = ? AND lot_no = ? AND marked_at > ?`,
    [modelConditionId, lotNo, reset_at]
  );
  return base_count + rows[0].cnt;
}

// True once an admin/engineer/machine_controller has run "Complete
// Setting" for this (model_condition_id, lot_no) at least once since
// the last reset. Used to gate operator ("mass") logging.
async function isSettingComplete(modelConditionId, lotNo) {
  const [rows] = await pool.query(
    `SELECT 1 FROM production_count_reset
      WHERE model_condition_id = ? AND lot_no = ? AND reset_reason = 'setting_complete'
      LIMIT 1`,
    [modelConditionId, lotNo]
  );
  return rows.length > 0;
}

// True once a non-null target has been set for (model, lot_no). Used to
// block operators from starting mass production with no goal defined.
async function hasGoalSet(model, lotNo) {
  const [rows] = await pool.query(
    'SELECT goal_count FROM production_goal WHERE model = ? AND lot_no = ?',
    [model, lotNo]
  );
  return rows.length > 0 && rows[0].goal_count !== null && rows[0].goal_count !== undefined;
}

// ---------------- GET /api/production/timings?model_condition_id= ----------------
async function getTimings(req, res) {
  const { model_condition_id } = req.query;
  if (!model_condition_id) {
    return res.status(400).json({ error: 'model_condition_id is required.' });
  }
  try {
    const model = await resolveModel(model_condition_id);
    if (!model) return res.status(404).json({ error: 'Model condition not found.' });

    const { reset_at } = await getResetInfo(model_condition_id, model.lot_no);
    const [rows] = await pool.query(
      `SELECT type, MIN(marked_at) AS first_at
         FROM production_log
        WHERE model_condition_id = ? AND lot_no = ? AND marked_at > ?
        GROUP BY type`,
      [model_condition_id, model.lot_no, reset_at]
    );

    let setting_started_at = null;
    let mass_started_at = null;
    rows.forEach((r) => {
      if (r.type === 'setting') setting_started_at = r.first_at;
      if (r.type === 'mass') mass_started_at = r.first_at;
    });

    return res.json({ lot_no: model.lot_no, setting_started_at, mass_started_at });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error fetching timings.' });
  }
}

async function computeSettingCount(modelConditionId, lotNo) {
  const { reset_at } = await getResetInfo(modelConditionId, lotNo);
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM production_log
      WHERE model_condition_id = ? AND lot_no = ? AND type = 'setting' AND marked_at > ?`,
    [modelConditionId, lotNo, reset_at]
  );
  return rows[0].cnt;
}

// ---------------- GET /api/production/count?model_condition_id= ----------------
async function getCount(req, res) {
  const { model_condition_id } = req.query;
  if (!model_condition_id) {
    return res.status(400).json({ error: 'model_condition_id is required.' });
  }
  try {
    const model = await resolveModel(model_condition_id);
    if (!model) return res.status(404).json({ error: 'Model condition not found.' });
    const count = await computeCount(model_condition_id, model.lot_no);
    return res.json({ count, lot_no: model.lot_no });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error fetching count.' });
  }
}

// ---------------- POST /api/production/log ----------------
async function logProduction(req, res) {
  const { model_condition_id, pallet_no, code2d_result } = req.body || {};
  if (!model_condition_id || !pallet_no) {
    return res.status(400).json({ error: 'model_condition_id and pallet_no are required.' });
  }
  if (code2d_result !== undefined && code2d_result !== null && !['R', 'S', 'T'].includes(code2d_result)) {
    return res.status(400).json({ error: "code2d_result must be one of 'R', 'S', 'T'." });
  }

  try {
    const model = await resolveModel(model_condition_id);
    if (!model) return res.status(404).json({ error: 'Model condition not found.' });
    if (model.pallet_no !== pallet_no) {
      return res.status(400).json({ error: `That model is assigned to ${model.pallet_no}, not ${pallet_no}.` });
    }

    const actor = req.user || {};
    const type = actor.role === 'operator' ? 'mass' : 'setting';

    // Gate: mass production may not start until Complete Setting has
    // run at least once for this model/lot combo.
    if (type === 'mass') {
      const complete = await isSettingComplete(model_condition_id, model.lot_no);
      if (!complete) {
        return res.status(409).json({
          error: 'Setting has not been completed for this model/lot yet. Ask an Admin, Engineer, or Machine Controller to run "Complete Setting" on the Monitor page first.',
        });
      }

      // NEW — Gate: mass production may not start until a production
      // target (goal) has been set for this model/lot.
      const goalSet = await hasGoalSet(model.model, model.lot_no);
      if (!goalSet) {
        return res.status(409).json({
          error: 'No production target has been set for this model/lot yet. Set a target on the Monitor page before starting mass production.',
        });
      }
    }

    const [items] = await pool.query(
      'SELECT condition_name, condition_value, block_no FROM model_condition_item WHERE model_condition_id = ? ORDER BY sort_order',
      [model_condition_id]
    );

    const [result] = await pool.query(
      `INSERT INTO production_log
        (model, job_no, pallet_no, lot_no, count, model_condition_id,
         user_id, employee_id, user_name, user_role, type, conditions, code2d_result)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        model.model,
        model.job_no,
        pallet_no,
        model.lot_no,
        model_condition_id,
        actor.id ?? null,
        actor.employee_id ?? null,
        actor.name ?? null,
        actor.role ?? null,
        type,
        JSON.stringify(items),
        code2d_result ?? null,
      ]
    );

    const count = await computeCount(model_condition_id, model.lot_no);
    await pool.query('UPDATE production_log SET count = ? WHERE id = ?', [count, result.insertId]);

    return res.status(201).json({
      id: result.insertId,
      count,
      type,
      lot_no: model.lot_no,
      marked_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error logging production count.' });
  }
}

// ---------------- POST /api/production/reset ----------------
async function resetCount(req, res) {
  const { model_condition_id } = req.body || {};
  if (!model_condition_id) {
    return res.status(400).json({ error: 'model_condition_id is required.' });
  }
  try {
    const model = await resolveModel(model_condition_id);
    if (!model) return res.status(404).json({ error: 'Model condition not found.' });

    await pool.query(
      `INSERT INTO production_count_reset (model_condition_id, lot_no, reset_at, base_count, reset_reason, reset_by_user_id)
       VALUES (?, ?, NOW(), 0, 'manual_reset', ?)
       ON DUPLICATE KEY UPDATE reset_at = NOW(), base_count = 0, reset_reason = 'manual_reset', reset_by_user_id = VALUES(reset_by_user_id)`,
      [model_condition_id, model.lot_no, req.user ? req.user.id : null]
    );

    await systemLog.logAction({
      req,
      action: 'production.count_reset',
      targetType: 'model_condition',
      targetId: model_condition_id,
      description: `Reset displayed part count for "${model.model}" (Lot ${model.lot_no}) — history preserved`,
      details: { model_condition_id, lot_no: model.lot_no },
    });

    return res.json({ count: 0, lot_no: model.lot_no });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error resetting count.' });
  }
}

// ---------------- GET /api/production/setting-summary?model_condition_id= ----------------
async function getSettingSummary(req, res) {
  const { model_condition_id } = req.query;
  if (!model_condition_id) {
    return res.status(400).json({ error: 'model_condition_id is required.' });
  }
  try {
    const model = await resolveModel(model_condition_id);
    if (!model) return res.status(404).json({ error: 'Model condition not found.' });

    const [items] = await pool.query(
      'SELECT condition_name, condition_value, block_no FROM model_condition_item WHERE model_condition_id = ? ORDER BY sort_order',
      [model_condition_id]
    );
    const setting_count = await computeSettingCount(model_condition_id, model.lot_no);

    return res.json({
      model_condition_id: Number(model_condition_id),
      model: model.model,
      job_no: model.job_no,
      pallet_no: model.pallet_no,
      lot_no: model.lot_no,
      conditions: items,
      setting_count,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error fetching setting summary.' });
  }
}

// ---------------- POST /api/production/complete-setting ----------------
async function completeSetting(req, res) {
  const { model_condition_id, base_count } = req.body || {};
  if (!model_condition_id) {
    return res.status(400).json({ error: 'model_condition_id is required.' });
  }
  const baseCountNum = Number(base_count);
  if (!Number.isInteger(baseCountNum) || baseCountNum < 0) {
    return res.status(400).json({ error: 'base_count must be a non-negative integer.' });
  }

  try {
    const model = await resolveModel(model_condition_id);
    if (!model) return res.status(404).json({ error: 'Model condition not found.' });

    await pool.query(
      `INSERT INTO production_count_reset (model_condition_id, lot_no, reset_at, base_count, reset_reason, reset_by_user_id)
       VALUES (?, ?, NOW(), ?, 'setting_complete', ?)
       ON DUPLICATE KEY UPDATE reset_at = NOW(), base_count = VALUES(base_count),
         reset_reason = 'setting_complete', reset_by_user_id = VALUES(reset_by_user_id)`,
      [model_condition_id, model.lot_no, baseCountNum, req.user ? req.user.id : null]
    );

    await systemLog.logAction({
      req,
      action: 'production.setting_complete',
      targetType: 'model_condition',
      targetId: model_condition_id,
      description: `Completed setting for "${model.model}" (Lot ${model.lot_no}) — mass production count starts at ${baseCountNum}`,
      details: { model_condition_id, lot_no: model.lot_no, base_count: baseCountNum },
    });

    return res.json({ count: baseCountNum, lot_no: model.lot_no });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error completing setting.' });
  }
}

// ---------------- POST /api/production/continue-lot ----------------
// Used by the Monitor "Next Step > Continuous" flow when the operator
// changes the Lot No. instead of just extending the goal on the same
// lot. Carries the 'setting_complete' status from old_lot_no forward
// onto new_lot_no — but ONLY if old_lot_no genuinely had it. This is
// intentionally NOT a way to skip Complete Setting for a real new
// setup: if the old lot never had it, this is a no-op and the normal
// gate in logProduction() still applies.
async function continueLot(req, res) {
  const { model_condition_id, old_lot_no, new_lot_no } = req.body || {};
  if (!model_condition_id || !old_lot_no || !new_lot_no) {
    return res.status(400).json({ error: 'model_condition_id, old_lot_no and new_lot_no are required.' });
  }
  if (old_lot_no === new_lot_no) {
    return res.json({ carried: false, reason: 'Lot unchanged.' });
  }

  try {
    const model = await resolveModel(model_condition_id);
    if (!model) return res.status(404).json({ error: 'Model condition not found.' });

    const wasComplete = await isSettingComplete(model_condition_id, old_lot_no);
    if (!wasComplete) {
      // Nothing to carry forward — the new lot starts fresh and still
      // requires a real Complete Setting run, same as any new lot.
      return res.json({ carried: false, reason: 'Setting was not completed on the previous lot.' });
    }

    await pool.query(
      `INSERT INTO production_count_reset (model_condition_id, lot_no, reset_at, base_count, reset_reason, reset_by_user_id)
       VALUES (?, ?, NOW(), 0, 'setting_complete', ?)
       ON DUPLICATE KEY UPDATE reset_at = NOW(), base_count = 0,
         reset_reason = 'setting_complete', reset_by_user_id = VALUES(reset_by_user_id)`,
      [model_condition_id, new_lot_no, req.user ? req.user.id : null]
    );

    await systemLog.logAction({
      req,
      action: 'production.continue_lot',
      targetType: 'model_condition',
      targetId: model_condition_id,
      description: `Carried "setting complete" from lot "${old_lot_no}" to "${new_lot_no}" on "${model.model}" (Continuous)`,
      details: { model_condition_id, old_lot_no, new_lot_no },
    });

    return res.json({ carried: true, lot_no: new_lot_no });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error continuing lot setting status.' });
  }
}

// ---------------- GET /api/production/goal?model=&lot_no= ----------------
// Combined progress toward a shared target across every model_condition
// row currently sharing this (model, lot_no) — e.g. Pallet1 Job 0001 +
// Pallet2 Job 0002, same model & lot, counted together.
async function getGoal(req, res) {
  const { model, lot_no } = req.query;
  if (!model || !lot_no) {
    return res.status(400).json({ error: 'model and lot_no are required.' });
  }
  try {
    const [goalRows] = await pool.query(
      'SELECT goal_count FROM production_goal WHERE model = ? AND lot_no = ?',
      [model, lot_no]
    );
    const goal_count = goalRows.length ? goalRows[0].goal_count : null;

    const [conditionRows] = await pool.query(
      'SELECT id FROM model_condition WHERE model = ? AND lot_no = ?',
      [model, lot_no]
    );

    let current_count = 0;
    for (const row of conditionRows) {
      current_count += await computeCount(row.id, lot_no);
    }

    return res.json({
      model,
      lot_no,
      goal_count,
      current_count,
      reached: goal_count !== null && current_count >= goal_count,
      model_condition_ids: conditionRows.map((r) => r.id),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error fetching goal.' });
  }
}

// ---------------- POST /api/production/goal ----------------
async function setGoal(req, res) {
  const { model, lot_no, goal_count } = req.body || {};
  if (!model || !lot_no) {
    return res.status(400).json({ error: 'model and lot_no are required.' });
  }
  const goalNum = Number(goal_count);
  if (!Number.isInteger(goalNum) || goalNum < 0) {
    return res.status(400).json({ error: 'goal_count must be a non-negative integer.' });
  }
  try {
    await pool.query(
      `INSERT INTO production_goal (model, lot_no, goal_count, set_by_user_id)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE goal_count = VALUES(goal_count), set_by_user_id = VALUES(set_by_user_id)`,
      [model, lot_no, goalNum, req.user ? req.user.id : null]
    );

    await systemLog.logAction({
      req,
      action: 'production.goal_set',
      targetType: 'production_goal',
      targetId: `${model}::${lot_no}`,
      description: `Set production goal for "${model}" (Lot ${lot_no}) to ${goalNum} pcs`,
      details: { model, lot_no, goal_count: goalNum },
    });

    return res.json({ model, lot_no, goal_count: goalNum });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error setting goal.' });
  }
}

// ---------------- DELETE /api/production/goal ----------------
async function deleteGoal(req, res) {
  const { model, lot_no } = req.body || {};
  if (!model || !lot_no) {
    return res.status(400).json({ error: 'model and lot_no are required.' });
  }
  try {
    await pool.query('DELETE FROM production_goal WHERE model = ? AND lot_no = ?', [model, lot_no]);

    await systemLog.logAction({
      req,
      action: 'production.goal_clear',
      targetType: 'production_goal',
      targetId: `${model}::${lot_no}`,
      description: `Cleared production goal for "${model}" (Lot ${lot_no})`,
    });

    return res.json({ cleared: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error clearing goal.' });
  }
}

// ---------------- GET /api/production/my-summary ----------------
// Stats (today/week/month/all-time), 30-day trend, and a Model Count
// breakdown — total parts per model, filtered to the type that
// matches this user's role (operator -> mass, everyone else ->
// setting), since those are the counts that actually represent
// "what this account produced."
async function getMySummary(req, res) {
  const userId = req.user.id;
  const modelCountType = req.user.role === 'operator' ? 'mass' : 'setting';

  try {
    const [statRows] = await pool.query(
      `SELECT
         type,
         SUM(CASE WHEN DATE(marked_at) = CURDATE() THEN 1 ELSE 0 END) AS today,
         SUM(CASE WHEN YEARWEEK(marked_at, 1) = YEARWEEK(CURDATE(), 1) THEN 1 ELSE 0 END) AS week,
         SUM(CASE WHEN YEAR(marked_at) = YEAR(CURDATE()) AND MONTH(marked_at) = MONTH(CURDATE()) THEN 1 ELSE 0 END) AS month,
         COUNT(*) AS all_time
       FROM production_log
       WHERE user_id = ?
       GROUP BY type`,
      [userId]
    );

    const stats = {
      mass:    { today: 0, week: 0, month: 0, all_time: 0 },
      setting: { today: 0, week: 0, month: 0, all_time: 0 },
    };
    statRows.forEach((row) => {
      const bucket = row.type === 'mass' ? 'mass' : 'setting';
      stats[bucket] = {
        today: Number(row.today) || 0,
        week: Number(row.week) || 0,
        month: Number(row.month) || 0,
        all_time: Number(row.all_time) || 0,
      };
    });

    const [trendRows] = await pool.query(
      `SELECT DATE(marked_at) AS d, type, COUNT(*) AS cnt
         FROM production_log
        WHERE user_id = ? AND marked_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
        GROUP BY DATE(marked_at), type
        ORDER BY d ASC`,
      [userId]
    );

    const byDate = {};
    trendRows.forEach((row) => {
      const key = row.d instanceof Date ? row.d.toISOString().slice(0, 10) : String(row.d).slice(0, 10);
      const bucket = (byDate[key] ||= { mass: 0, setting: 0 });
      bucket[row.type === 'mass' ? 'mass' : 'setting'] = Number(row.cnt) || 0;
    });

    const trend = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const bucket = byDate[key] || { mass: 0, setting: 0 };
      trend.push({ date: key, mass: bucket.mass, setting: bucket.setting });
    }

    // Model Count — total parts per model for the type matching this
    // user's role. e.g. an operator sees how many of each model they
    // mass-produced; an engineer/admin/machine_controller sees how
    // many of each model they set up.
    const [modelRows] = await pool.query(
      `SELECT model, COUNT(*) AS cnt
         FROM production_log
        WHERE user_id = ? AND type = ?
        GROUP BY model
        ORDER BY cnt DESC
        LIMIT 25`,
      [userId, modelCountType]
    );
    const model_counts = modelRows.map((r) => ({ model: r.model, count: Number(r.cnt) || 0 }));

    return res.json({
      stats,
      trend,
      model_counts,
      model_count_type: modelCountType, // so the UI can label the chart correctly
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error fetching production summary.' });
  }
}

// ---------------- GET /api/production/my-recent?page=&pageSize= ----------------
// Paginated recent-activity list (own account only), 10/page by
// default. Split out from my-summary so paging doesn't require
// refetching stats/trend/model counts every time.
const MY_RECENT_DEFAULT_PAGE_SIZE = 10;
const MY_RECENT_MAX_PAGE_SIZE = 100;

async function getMyRecent(req, res) {
  const userId = req.user.id;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(
    MY_RECENT_MAX_PAGE_SIZE,
    Math.max(1, parseInt(req.query.pageSize, 10) || MY_RECENT_DEFAULT_PAGE_SIZE)
  );
  const offset = (page - 1) * pageSize;

  try {
    const [countRows] = await pool.query(
      'SELECT COUNT(*) AS total FROM production_log WHERE user_id = ?',
      [userId]
    );
    const total = countRows[0].total;

    const [rows] = await pool.query(
      `SELECT model, job_no, lot_no, pallet_no, type, marked_at
         FROM production_log
        WHERE user_id = ?
        ORDER BY marked_at DESC
        LIMIT ? OFFSET ?`,
      [userId, pageSize, offset]
    );

    return res.json({
      rows: rows.map((r) => ({
        model: r.model,
        job_no: r.job_no,
        lot_no: r.lot_no,
        pallet_no: r.pallet_no,
        type: r.type,
        marked_at: r.marked_at,
      })),
      total,
      page,
      pageSize,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error fetching recent activity.' });
  }
}

module.exports = {
  getCount,
  getTimings,
  logProduction,
  resetCount,
  getSettingSummary,
  completeSetting,
  continueLot,
  getGoal,
  setGoal,
  deleteGoal,
  getMySummary,
  getMyRecent, // NEW
};