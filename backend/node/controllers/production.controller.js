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

// Count of parts logged by non-operator roles ("setting" type) since
// the last reset/complete stamp — used to prefill the Complete Setting
// popup. Deliberately ignores base_count (that's a separate concern).
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

    const [items] = await pool.query(
      'SELECT condition_name, condition_value, block_no FROM model_condition_item WHERE model_condition_id = ? ORDER BY sort_order',
      [model_condition_id]
    );

    const actor = req.user || {};
    const type = actor.role === 'operator' ? 'mass' : 'setting';

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
// Powers the "Complete Setting" popup: model info, its condition
// values, and how many parts have been logged under 'setting' type
// since the last reset/complete (the number the admin can then edit).
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
// Locks in the (possibly edited) setting count as the new baseline for
// this model/lot, so the next part an operator marks continues counting
// up from there. Does not touch production_log history.
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

module.exports = {
  getCount,
  logProduction,
  resetCount,
  getSettingSummary,
  completeSetting,
};