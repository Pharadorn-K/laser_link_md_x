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
// ============================================================
const pool = require('../config/db');
const fs = require('fs');
const path = require('path');

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
  if (!body.model || String(body.model).trim() === '') {
    return 'model is required.';
  }
  const jobNo = Number(body.job_no);
  if (!Number.isInteger(jobNo) || jobNo < 0 || jobNo > 1999) {
    return 'job_no must be an integer between 0 and 1999.';
  }
  if (!['Pallet1', 'Pallet2'].includes(body.pallet_no)) {
    return "pallet_no must be 'Pallet1' or 'Pallet2'.";
  }

  // Lot No. is mandatory on every model — it gets replaced every 150
  // parts (or fewer), so operators update its value later from the
  // pallet card, but a starting value + BLK slot is required up front.
  if (!body.lot_no || !String(body.lot_no).trim()) {
    return 'Lot No. is required.';
  }
  const lotBlock = Number(body.lot_no_block);
  if (!Number.isInteger(lotBlock) || lotBlock < 0 || lotBlock > 255) {
    return 'Lot No. BLK number must be an integer between 0 and 255.';
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
    lot_no_block: Number(body.lot_no_block),
  };
  if (photoPath !== undefined) {
    fields.photo_path = photoPath;
  }
  return fields;
}

function diskPathFromPublicPath(publicPath) {
  // publicPath looks like "/uploads/models/xyz.png"
  return path.join(__dirname, '..', publicPath.replace(/^\/uploads\//, 'uploads/'));
}

// Inserts non-blank condition rows for a model_condition_id, in order.
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

    // Only remove the replaced photo file once the DB commit succeeded.
    if (oldPhotoPath) {
      fs.unlink(diskPathFromPublicPath(oldPhotoPath), () => {});
    }

    const full = await getFullModel(req.params.id);
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
  const [rows] = await pool.query('SELECT photo_path FROM model_condition WHERE id = ?', [req.params.id]);
  const [result] = await pool.query('DELETE FROM model_condition WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Model condition not found.' });
  if (rows[0] && rows[0].photo_path) {
    fs.unlink(diskPathFromPublicPath(rows[0].photo_path), () => {});
  }
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
  const [result] = await pool.query(
    'UPDATE model_condition_item SET condition_value = ? WHERE id = ? AND model_condition_id = ?',
    [String(condition_value).trim(), itemId, id]
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Condition not found.' });
  const full = await getFullModel(id);
  return res.json(full);
}

async function updateLotNo(req, res) {
  const { id } = req.params;
  const { lot_no } = req.body;
  if (!lot_no || !String(lot_no).trim()) {
    return res.status(400).json({ error: 'lot_no is required.' });
  }
  const [result] = await pool.query(
    'UPDATE model_condition SET lot_no = ? WHERE id = ?',
    [String(lot_no).trim(), id]
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Model condition not found.' });
  const full = await getFullModel(id);
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
  listConditionNames,
  MAX_CONDITIONS,
};