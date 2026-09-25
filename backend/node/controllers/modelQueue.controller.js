// backend/node/controllers/modelQueue.controller.js
// ============================================================
// Per-piece condition queue ("special case marking").
//
//   Some conditions (e.g. QRCode, Heat Lot No 2) change on EVERY
//   marked part. They are flagged is_variable on model_condition_item,
//   and their real values are loaded from a CSV (one row per part)
//   into model_piece_queue. A new lot = a new CSV that REPLACES the
//   old queue. production_log stays the permanent per-part record.
//
//   getQueue      GET    /api/models/:id/queue          summary + next values
//   importQueue   POST   /api/models/:id/queue/import   {columns, rows, dry_run}
//   clearQueue    DELETE /api/models/:id/queue
//   guardVariableConditions  middleware for POST/PUT /api/models
//
//   CSV rules (enforced here, authoritative — the browser only previews):
//     - header = the model's per-piece condition names (case-insensitive,
//       any order); no unknown columns, none missing
//     - every value: non-empty, <= 255 chars, printable ASCII only,
//       NO commas (the laser command is comma-delimited and laser_core.py
//       encodes as ASCII, so anything else would corrupt or crash the send)
// ============================================================
const fs = require('fs');
const pool = require('../config/db');
const systemLog = require('../services/systemLog.service');

const MAX_ROWS = 10000;
const MAX_VALUE_LEN = 255;
const INSERT_CHUNK = 500;
const MAX_REPORTED_ERRORS = 20;
const PREVIEW_ROWS = 5;
const SAFE_VALUE = /^[\x20-\x7e]+$/; // printable ASCII

const norm = (s) => String(s === undefined || s === null ? '' : s).trim().toLowerCase();
const trimmed = (s) => String(s === undefined || s === null ? '' : s).trim();

function isTrue(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function parseValues(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch (e) {
    return {};
  }
}

async function getModelRow(id) {
  const [rows] = await pool.query('SELECT id, model, lot_no FROM model_condition WHERE id = ?', [id]);
  return rows.length ? rows[0] : null;
}

async function getVariableNames(modelId) {
  const [rows] = await pool.query(
    `SELECT condition_name FROM model_condition_item
      WHERE model_condition_id = ? AND is_variable = 1
      ORDER BY sort_order`,
    [modelId]
  );
  return rows.map((r) => r.condition_name);
}

async function getCounts(modelId) {
  const [rows] = await pool.query(
    'SELECT status, COUNT(*) AS n FROM model_piece_queue WHERE model_condition_id = ? GROUP BY status',
    [modelId]
  );
  const counts = { pending: 0, reserved: 0, marked: 0, failed: 0, total: 0 };
  rows.forEach((r) => {
    const n = Number(r.n) || 0;
    counts[r.status] = n;
    counts.total += n;
  });
  return counts;
}

// ---------------- GET /api/models/:id/queue ----------------
async function getQueue(req, res) {
  try {
    const model = await getModelRow(req.params.id);
    if (!model) return res.status(404).json({ error: 'Model condition not found.' });

    const variable_names = await getVariableNames(model.id);
    const counts = await getCounts(model.id);

    const [lotRows] = await pool.query(
      'SELECT lot_no FROM model_piece_queue WHERE model_condition_id = ? LIMIT 1',
      [model.id]
    );
    const [nextRows] = await pool.query(
      `SELECT seq_no, piece_values FROM model_piece_queue
        WHERE model_condition_id = ? AND status = 'pending'
        ORDER BY seq_no ASC LIMIT 3`,
      [model.id]
    );

    return res.json({
      model_condition_id: model.id,
      model: model.model,
      variable_names,
      model_lot_no: model.lot_no,
      queue_lot_no: lotRows.length ? lotRows[0].lot_no : null,
      counts,
      next: nextRows.map((r) => ({ seq_no: r.seq_no, values: parseValues(r.piece_values) })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error fetching per-piece queue.' });
  }
}

// ---------------- POST /api/models/:id/queue/import ----------------
// Body: { columns: string[], rows: string[][], dry_run?: boolean }
// dry_run validates and reports what WOULD happen without writing.
async function importQueue(req, res) {
  const { columns, rows, dry_run } = req.body || {};

  try {
    const model = await getModelRow(req.params.id);
    if (!model) return res.status(404).json({ error: 'Model condition not found.' });

    const variableNames = await getVariableNames(model.id);
    if (variableNames.length === 0) {
      return res.status(400).json({
        error: 'This model has no per-piece conditions. Tick "Per-piece" on a condition and save the model first.',
      });
    }

    if (!Array.isArray(columns) || !Array.isArray(rows)) {
      return res.status(400).json({ error: 'columns and rows are required.' });
    }
    if (rows.length === 0) {
      return res.status(400).json({ error: 'The CSV has no data rows.' });
    }
    if (rows.length > MAX_ROWS) {
      return res.status(400).json({ error: `The CSV has ${rows.length} rows; the limit is ${MAX_ROWS}.` });
    }

    // ---- header -> canonical condition names ----
    const byNorm = new Map(variableNames.map((n) => [norm(n), n]));
    const colMap = [];
    const seen = new Set();
    const unknown = [];
    const headerErrors = [];

    columns.forEach((c, i) => {
      const canonical = byNorm.get(norm(c));
      if (!canonical) {
        unknown.push(trimmed(c) || `(column ${i + 1})`);
        colMap.push(null);
        return;
      }
      if (seen.has(canonical)) headerErrors.push(`Column "${canonical}" appears more than once.`);
      seen.add(canonical);
      colMap.push(canonical);
    });
    if (unknown.length) {
      headerErrors.push(`Unknown column(s): ${unknown.join(', ')}. Expected: ${variableNames.join(', ')}.`);
    }
    const missing = variableNames.filter((n) => !seen.has(n));
    if (missing.length) headerErrors.push(`Missing column(s): ${missing.join(', ')}.`);
    if (headerErrors.length) {
      return res.status(400).json({ error: headerErrors[0], errors: headerErrors, error_count: headerErrors.length });
    }

    // ---- rows ----
    const parsed = [];
    const errors = [];
    let errorCount = 0;
    const addError = (msg) => {
      errorCount += 1;
      if (errors.length < MAX_REPORTED_ERRORS) errors.push(msg);
    };

    rows.forEach((r, idx) => {
      const line = idx + 2; // header is line 1
      if (!Array.isArray(r) || r.length !== columns.length) {
        addError(`Row ${line}: expected ${columns.length} column(s), found ${Array.isArray(r) ? r.length : 0}.`);
        return;
      }
      const obj = {};
      for (let c = 0; c < colMap.length; c += 1) {
        const name = colMap[c];
        const val = trimmed(r[c]);
        if (!val) addError(`Row ${line}, "${name}": value is empty.`);
        else if (val.length > MAX_VALUE_LEN) addError(`Row ${line}, "${name}": longer than ${MAX_VALUE_LEN} characters.`);
        else if (!SAFE_VALUE.test(val)) addError(`Row ${line}, "${name}": only printable ASCII characters are allowed ("${val.slice(0, 30)}").`);
        else if (val.includes(',')) addError(`Row ${line}, "${name}": commas are not allowed in a marking value ("${val.slice(0, 30)}").`);
        obj[name] = val;
      }
      parsed.push(obj);
    });

    if (errorCount > 0) {
      return res.status(400).json({
        error: `${errorCount} problem(s) found in the CSV. Nothing was imported.`,
        errors,
        error_count: errorCount,
      });
    }

    // ---- warnings (do not block) ----
    const warnings = [];
    const seenKeys = new Set();
    let dupes = 0;
    parsed.forEach((o) => {
      const key = JSON.stringify(variableNames.map((n) => o[n]));
      if (seenKeys.has(key)) dupes += 1;
      else seenKeys.add(key);
    });
    if (dupes > 0) warnings.push(`${dupes} row(s) repeat an earlier row exactly — the same content would be marked more than once.`);

    // ---- what would be replaced ----
    const existing = await getCounts(model.id);
    if (existing.reserved > 0) {
      return res.status(409).json({
        error: `${existing.reserved} piece(s) are currently reserved (marking in progress). Wait for them to finish before replacing the queue.`,
      });
    }

    const summary = {
      ok: true,
      model_condition_id: model.id,
      model: model.model,
      lot_no: model.lot_no,
      variable_names: variableNames,
      total: parsed.length,
      preview: parsed.slice(0, PREVIEW_ROWS),
      warnings,
      will_replace: existing,
    };

    if (dry_run) return res.json({ ...summary, dry_run: true });

    // ---- replace the queue atomically ----
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Re-check inside the transaction and lock, in case a marking reserved a row since the check above.
      const [reservedRows] = await conn.query(
        `SELECT COUNT(*) AS n FROM model_piece_queue
          WHERE model_condition_id = ? AND status = 'reserved' FOR UPDATE`,
        [model.id]
      );
      if (reservedRows[0].n > 0) {
        await conn.rollback();
        return res.status(409).json({ error: 'A piece was reserved while importing. Try again in a moment.' });
      }

      await conn.query('DELETE FROM model_piece_queue WHERE model_condition_id = ?', [model.id]);

      for (let i = 0; i < parsed.length; i += INSERT_CHUNK) {
        const chunk = parsed
          .slice(i, i + INSERT_CHUNK)
          .map((o, j) => [model.id, model.lot_no, i + j + 1, JSON.stringify(o)]);
        await conn.query(
          'INSERT INTO model_piece_queue (model_condition_id, lot_no, seq_no, piece_values) VALUES ?',
          [chunk]
        );
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    await systemLog.logAction({
      req,
      action: 'model.queue_import',
      targetType: 'model_condition',
      targetId: model.id,
      description: `Imported ${parsed.length} per-piece row(s) for "${model.model}" (Lot ${model.lot_no}), replacing ${existing.total} old row(s)`,
      details: {
        total: parsed.length,
        columns: variableNames,
        lot_no: model.lot_no,
        replaced: existing,
        warnings,
      },
    });

    return res.status(201).json({ ...summary, dry_run: false, imported: parsed.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error importing per-piece values.' });
  }
}

// ---------------- DELETE /api/models/:id/queue ----------------
async function clearQueue(req, res) {
  try {
    const model = await getModelRow(req.params.id);
    if (!model) return res.status(404).json({ error: 'Model condition not found.' });

    const existing = await getCounts(model.id);
    if (existing.reserved > 0) {
      return res.status(409).json({ error: 'A piece is reserved (marking in progress). Wait for it to finish first.' });
    }

    await pool.query('DELETE FROM model_piece_queue WHERE model_condition_id = ?', [model.id]);

    await systemLog.logAction({
      req,
      action: 'model.queue_clear',
      targetType: 'model_condition',
      targetId: model.id,
      description: `Cleared per-piece queue for "${model.model}" (${existing.total} row(s), ${existing.pending} unmarked)`,
      details: { cleared: existing },
    });

    return res.json({ cleared: existing.total });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error clearing per-piece queue.' });
  }
}

// ---------------- middleware: POST / PUT /api/models ----------------
// Runs AFTER multer (so req.body is populated, and req.file may exist).
//   1. per-piece condition names must be unique within the model
//   2. on PUT: while the queue still has pending/reserved rows, the SET of
//      per-piece condition names may not change (rows are keyed by name, so a
//      rename/removal would orphan them). Clear the queue first.
function readIncomingConditions(body) {
  let c = body && body.conditions;
  if (typeof c === 'string') {
    try {
      c = JSON.parse(c);
    } catch (e) {
      c = [];
    }
  }
  return Array.isArray(c) ? c : [];
}

async function guardVariableConditions(req, res, next) {
  const reject = (status, error) => {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(status).json({ error });
  };

  try {
    const names = readIncomingConditions(req.body)
      .filter((c) => c && isTrue(c.is_variable) && trimmed(c.condition_name))
      .map((c) => trimmed(c.condition_name));

    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) {
      return reject(400, 'Per-piece condition names must be unique within a model.');
    }

    if (!req.params.id) return next(); // POST: nothing queued yet

    const [cnt] = await pool.query(
      `SELECT COUNT(*) AS n FROM model_piece_queue
        WHERE model_condition_id = ? AND status IN ('pending', 'reserved')`,
      [req.params.id]
    );
    const active = Number(cnt[0].n) || 0;
    if (!active) return next();

    const current = (await getVariableNames(req.params.id)).map(trimmed).sort();
    const wanted = names.slice().sort();
    if (JSON.stringify(current) !== JSON.stringify(wanted)) {
      return reject(
        409,
        `This model still has ${active} unmarked per-piece row(s) in its queue. ` +
          'Clear the queue (or finish the lot) before changing which conditions are per-piece.'
      );
    }
    return next();
  } catch (e) {
    console.error(e);
    return reject(500, 'Server error checking per-piece conditions.');
  }
}

module.exports = { getQueue, importQueue, clearQueue, guardVariableConditions };
