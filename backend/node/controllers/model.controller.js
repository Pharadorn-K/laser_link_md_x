// backend/node/controllers/model.controller.js
// ============================================================
// Model Set controller
//   Model Set page: per (model, job_no, pallet) marking
//   condition, used to build the base laser command for a job.
//   Conditions are stored in the child table model_condition_item
//   (one row per condition) instead of fixed c1/b1..c3/b3 columns.
//   Lot No. is mandatory on every model (starting value + BLK set
//   at creation, updated later by operators like any condition).
//   photo_path is an optional reference part photo — only the path
//   is stored here; the file itself lives under uploads/models/.
//
//   Every create/update/delete/condition-set/lot-no/camera-toggle
//   action is recorded to system_log for admin traceability.
// ============================================================
const pool = require('../config/db');
const fs = require('fs');
const path = require('path');
const systemLog = require('../services/systemLog.service');

const MAX_CONDITIONS = 20;

function toBool(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

// multipart/form-data (used whenever a photo is attached) sends every
// field as a string, so JSON fields (conditions, start2dcode_params)
// arrive JSON-encoded from the front end. Normalize them back into
// arrays before validating / persisting.
function normalizeBody(body) {
  const out = { ...body };
  if (typeof out.conditions === 'string') {
    try { out.conditions = JSON.parse(out.conditions); } catch (e) { out.conditions = []; }
  }
  if (typeof out.start2dcode_params === 'string') {
    try { out.start2dcode_params = JSON.parse(out.start2dcode_params); } catch (e) { out.start2dcode_params = []; }
  }
  return out;
}

function validateBody(body) {
  if (!body.lot_no || !String(body.lot_no).trim()) {
    return 'Lot No. is required.';
  }
  const jobNo = Number(body.job_no);
  if (!Number.isInteger(jobNo) || jobNo < 0 || jobNo > 1999) {
    return 'job_no must be an integer between 0 and 1999.';
  }
  if (!['Pallet1', 'Pallet2'].includes(body.pallet_no)) {
    return "pallet_no must be 'Pallet1' or 'Pallet2'.";
  }

  if (!body.lot_no || !String(body.lot_no).trim()) {
    return 'Lot No. is required.';
  }

  const conditions = Array.isArray(body.conditions) ? body.conditions : [];
  if (conditions.length > MAX_CONDITIONS) {
    return `A model can have at most ${MAX_CONDITIONS} conditions.`;
  }
  for (const c of conditions) {
    const name = c && c.condition_name !== undefined ? String(c.condition_name).trim() : '';
    const value = c && c.condition_value !== undefined ? String(c.condition_value).trim() : '';
    if (!name && !value) continue; // fully blank row, ignored on save
    if (name && !value) return `Condition "${name}": a CharacterString value is required.`;
    if (value && !name) return `Condition with value "${value}": a condition name is required.`;
    const block = Number(c.block_no);
    if (!Number.isInteger(block) || block < 0 || block > 255) {
      return `Condition "${name}": BLK number must be an integer between 0 and 255.`;
    }
  }
  return null;
}

// photoPath: undefined = don't touch the column (no new file uploaded on
// an edit), null/string = set it explicitly (create, or replaced on edit).
function buildFieldsFromBody(body, photoPath) {
  const fields = {
    model: String(body.model).trim(),
    job_no: Number(body.job_no),
    pallet_no: body.pallet_no,
    check_read2dcode: toBool(body.check_read2dcode),
    check_grade2dcode: toBool(body.check_grade2dcode),
    control_grade: body.control_grade ? String(body.control_grade).trim() : null,
    check_camera: toBool(body.check_camera),
    check_lot_no: true, // always on — Lot No. is mandatory now
    lot_no: String(body.lot_no).trim(),
  };
  if (photoPath !== undefined) {
    fields.photo_path = photoPath;
  }
  return fields;
}

function diskPathFromPublicPath(publicPath) {
  return path.join(__dirname, '..', publicPath.replace(/^\/uploads\//, 'uploads/'));
}

async function insertConditionItems(conn, modelConditionId, conditions) {
  const list = Array.isArray(conditions) ? conditions : [];
  let order = 0;
  for (const c of list) {
    const name = c && c.condition_name !== undefined ? String(c.condition_name).trim() : '';
    const value = c && c.condition_value !== undefined ? String(c.condition_value).trim() : '';
    if (!name && !value) continue;
    const block = Number(c.block_no);
    await conn.query(
      `INSERT INTO model_condition_item (model_condition_id, condition_name, condition_value, block_no, sort_order)
       VALUES (?, ?, ?, ?, ?)`,
      [modelConditionId, name, value, block, order]
    );
    order += 1;
  }
}

async function getFullModel(id) {
  const [rows] = await pool.query('SELECT * FROM model_condition WHERE id = ?', [id]);
  if (rows.length === 0) return null;
  const [items] = await pool.query(
    'SELECT * FROM model_condition_item WHERE model_condition_id = ? ORDER BY sort_order',
    [id]
  );
  return { ...rows[0], conditions: items };
}

// ---------------- List (optionally filtered by pallet) ----------------
async function listModels(req, res) {
  const { pallet } = req.query;
  let sql = 'SELECT * FROM model_condition';
  const params = [];
  if (pallet) {
    sql += ' WHERE pallet_no = ?';
    params.push(pallet);
  }
  sql += ' ORDER BY model ASC, job_no ASC';
  const [rows] = await pool.query(sql, params);

  if (rows.length === 0) return res.json([]);

  const ids = rows.map((r) => r.id);
  const [items] = await pool.query(
    'SELECT * FROM model_condition_item WHERE model_condition_id IN (?) ORDER BY model_condition_id, sort_order',
    [ids]
  );
  const itemsByModel = {};
  items.forEach((it) => {
    (itemsByModel[it.model_condition_id] ||= []).push(it);
  });

  return res.json(rows.map((r) => ({ ...r, conditions: itemsByModel[r.id] || [] })));
}

// ---------------- Get one ----------------
async function getModel(req, res) {
  const full = await getFullModel(req.params.id);
  if (!full) return res.status(404).json({ error: 'Model condition not found.' });
  return res.json(full);
}

// ---------------- Create ----------------
async function createModel(req, res) {
  const body = normalizeBody(req.body);
  const err = validateBody(body);
  if (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: err });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const photoPath = req.file ? `/uploads/models/${req.file.filename}` : null;
    const fields = buildFieldsFromBody(body, photoPath);
    const columns = Object.keys(fields);
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map((k) => fields[k]);

    const [result] = await conn.query(
      `INSERT INTO model_condition (${columns.join(', ')}) VALUES (${placeholders})`,
      values
    );
    await insertConditionItems(conn, result.insertId, body.conditions);

    await conn.commit();
    const full = await getFullModel(result.insertId);

    await systemLog.logAction({
      req,
      action: 'model.create',
      targetType: 'model_condition',
      targetId: result.insertId,
      description: `Created model "${fields.model}" (Job ${fields.job_no}, ${fields.pallet_no})`,
      details: {
        model: fields.model,
        job_no: fields.job_no,
        pallet_no: fields.pallet_no,
        lot_no: fields.lot_no,
        conditions_count: (body.conditions || []).length,
      },
    });

    return res.status(201).json(full);
  } catch (e) {
    await conn.rollback();
    if (req.file) fs.unlink(req.file.path, () => {});
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'That Job No. is already used on this pallet.' });
    }
    console.error(e);
    return res.status(500).json({ error: 'Server error creating model condition.' });
  } finally {
    conn.release();
  }
}

// ---------------- Update ----------------
async function updateModel(req, res) {
  const body = normalizeBody(req.body);
  const err = validateBody(body);
  if (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: err });
  }

  const before = await getFullModel(req.params.id);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let photoPath; // undefined unless a new file was uploaded
    let oldPhotoPath = null;
    if (req.file) {
      const [existingRows] = await conn.query(
        'SELECT photo_path FROM model_condition WHERE id = ?',
        [req.params.id]
      );
      oldPhotoPath = existingRows[0] ? existingRows[0].photo_path : null;
      photoPath = `/uploads/models/${req.file.filename}`;
    }

    const fields = buildFieldsFromBody(body, photoPath);
    const columns = Object.keys(fields);
    const setSql = columns.map((k) => `${k} = ?`).join(', ');
    const values = columns.map((k) => fields[k]);
    values.push(req.params.id);

    const [result] = await conn.query(`UPDATE model_condition SET ${setSql} WHERE id = ?`, values);
    if (result.affectedRows === 0) {
      await conn.rollback();
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: 'Model condition not found.' });
    }

    await conn.query('DELETE FROM model_condition_item WHERE model_condition_id = ?', [req.params.id]);
    await insertConditionItems(conn, req.params.id, body.conditions);

    await conn.commit();

    if (oldPhotoPath) {
      fs.unlink(diskPathFromPublicPath(oldPhotoPath), () => {});
    }

    const full = await getFullModel(req.params.id);

    await systemLog.logAction({
      req,
      action: 'model.update',
      targetType: 'model_condition',
      targetId: req.params.id,
      description: `Updated model "${fields.model}" (Job ${fields.job_no}, ${fields.pallet_no})`,
      details: {
        before: before ? {
          model: before.model, job_no: before.job_no, pallet_no: before.pallet_no,
          lot_no: before.lot_no, check_camera: !!before.check_camera,
          conditions_count: (before.conditions || []).length,
        } : null,
        after: {
          model: fields.model, job_no: fields.job_no, pallet_no: fields.pallet_no,
          lot_no: fields.lot_no, check_camera: fields.check_camera,
          conditions_count: (body.conditions || []).length,
        },
      },
    });

    return res.json(full);
  } catch (e) {
    await conn.rollback();
    if (req.file) fs.unlink(req.file.path, () => {});
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'That Job No. is already used on this pallet.' });
    }
    console.error(e);
    return res.status(500).json({ error: 'Server error updating model condition.' });
  } finally {
    conn.release();
  }
}

// ---------------- Delete ----------------
async function deleteModel(req, res) {
  const [rows] = await pool.query(
    'SELECT model, job_no, pallet_no, photo_path FROM model_condition WHERE id = ?',
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Model condition not found.' });

  const [result] = await pool.query('DELETE FROM model_condition WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Model condition not found.' });
  if (rows[0].photo_path) {
    fs.unlink(diskPathFromPublicPath(rows[0].photo_path), () => {});
  }

  await systemLog.logAction({
    req,
    action: 'model.delete',
    targetType: 'model_condition',
    targetId: req.params.id,
    description: `Deleted model "${rows[0].model}" (Job ${rows[0].job_no}, ${rows[0].pallet_no})`,
  });

  return res.json({ deleted: Number(req.params.id) });
}

// ---------------- Condition-name autocomplete ----------------
async function listConditionNames(req, res) {
  const [rows] = await pool.query(
    'SELECT DISTINCT condition_name FROM model_condition_item ORDER BY condition_name ASC'
  );
  return res.json(rows.map((r) => r.condition_name));
}

async function updateConditionValue(req, res) {
  const { id, itemId } = req.params;
  const { condition_value } = req.body;
  if (!condition_value || !String(condition_value).trim()) {
    return res.status(400).json({ error: 'condition_value is required.' });
  }

  const [itemRows] = await pool.query(
    'SELECT * FROM model_condition_item WHERE id = ? AND model_condition_id = ?',
    [itemId, id]
  );
  if (itemRows.length === 0) return res.status(404).json({ error: 'Condition not found.' });
  const oldItem = itemRows[0];
  const newValue = String(condition_value).trim();

  await pool.query(
    'UPDATE model_condition_item SET condition_value = ? WHERE id = ? AND model_condition_id = ?',
    [newValue, itemId, id]
  );

  const full = await getFullModel(id);

  await systemLog.logAction({
    req,
    action: 'model.condition_update',
    targetType: 'model_condition',
    targetId: id,
    description: `Set "${oldItem.condition_name}" (BLK ${oldItem.block_no}) from "${oldItem.condition_value}" to "${newValue}" on "${full ? full.model : ''}"`,
    details: {
      item_id: itemId,
      condition_name: oldItem.condition_name,
      block_no: oldItem.block_no,
      from: oldItem.condition_value,
      to: newValue,
    },
  });

  return res.json(full);
}

async function updateLotNo(req, res) {
  const { id } = req.params;
  const { lot_no } = req.body;
  if (!lot_no || !String(lot_no).trim()) {
    return res.status(400).json({ error: 'lot_no is required.' });
  }

  const [oldRows] = await pool.query('SELECT lot_no, model FROM model_condition WHERE id = ?', [id]);
  if (oldRows.length === 0) return res.status(404).json({ error: 'Model condition not found.' });
  const before = oldRows[0];
  const newValue = String(lot_no).trim();

  await pool.query('UPDATE model_condition SET lot_no = ? WHERE id = ?', [newValue, id]);
  const full = await getFullModel(id);

  await systemLog.logAction({
    req,
    action: 'model.lotno_update',
    targetType: 'model_condition',
    targetId: id,
    description: `Changed Lot No. on "${before.model}" from "${before.lot_no}" to "${newValue}"`,
    details: { from: before.lot_no, to: newValue },
  });

  return res.json(full);
}

async function updateCameraCheck(req, res) {
  const { id } = req.params;
  const { check_camera } = req.body;
  if (check_camera === undefined || check_camera === null) {
    return res.status(400).json({ error: 'check_camera is required.' });
  }
  const value = toBool(check_camera);

  const [oldRows] = await pool.query('SELECT check_camera, model FROM model_condition WHERE id = ?', [id]);
  if (oldRows.length === 0) return res.status(404).json({ error: 'Model condition not found.' });
  const before = oldRows[0];

  await pool.query('UPDATE model_condition SET check_camera = ? WHERE id = ?', [value, id]);
  const full = await getFullModel(id);

  await systemLog.logAction({
    req,
    action: 'model.camera_toggle',
    targetType: 'model_condition',
    targetId: id,
    description: `${value ? 'Enabled' : 'Disabled'} Camera Check on "${before.model}"`,
    details: { from: !!before.check_camera, to: value },
  });

  return res.json(full);
}

module.exports = {
  listModels,
  getModel,
  createModel,
  updateModel,
  deleteModel,
  updateConditionValue,
  updateLotNo,
  updateCameraCheck,
  listConditionNames,
  MAX_CONDITIONS,
};