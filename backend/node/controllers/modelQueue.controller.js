// backend/node/controllers/modelQueue.controller.js
// ============================================================
// Per-piece condition queue, SHARED by (model, lot_no) — not by
// model_condition_id. This lets every pallet/job sharing the same
// model+lot (e.g. 1956834-1 on Job 0006/Pallet1 AND Job 0007/Pallet2)
// pull serials from one pool: whichever pallet marks next takes the
// next unused row.
//
// Row lifecycle:
//   pending  -> reserved   when its values are pushed to the laser
//   reserved -> marked     in the SAME transaction that writes the
//                          production_log row, after StartMarking OK
//                          (see production.controller.js logProduction)
//   reserved -> pending    if the cycle fails BEFORE marking (release)
//   reserved -> failed     if the outcome is ambiguous (fail) — never
//                          silently reused or skipped
//   A reserved row left untouched past STALE_RESERVATION_MS is swept
//   to 'failed' automatically (crash/disconnect safety net).
//
//   getQueue     GET    /api/piece-queue?model=&lot_no=
//   importQueue  POST   /api/piece-queue/import   {model, lot_no, columns, rows, dry_run}
//   clearQueue   DELETE /api/piece-queue?model=&lot_no=
//   reserveNext  POST   /api/piece-queue/reserve  {model, lot_no, model_condition_id, pallet_no}
//   releaseReserved POST /api/piece-queue/:queueId/release
//   failReserved    POST /api/piece-queue/:queueId/fail
//
//   guardVariableConditions  middleware for POST/PUT /api/models
//     - per-piece condition names must be unique within one model_condition
//     - per-piece condition NAMES must match every OTHER model_condition
//       row sharing the same (model, lot_no) — e.g. Job 0006/Pallet1 and
//       Job 0007/Pallet2 on the same lot must both tick "QR Code"
//     - while the shared queue still has pending/reserved rows for
//       (model, lot_no), the set of per-piece names for THIS row may not
//       change (would orphan/misalign the queue) — clear the queue first
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
const STALE_RESERVATION_MS = 5 * 60 * 1000; // 5 min — crash/disconnect safety net

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

// ---------------- shared helpers ----------------

// Sweeps any reserved row for (model, lot_no) that's been sitting
// reserved past STALE_RESERVATION_MS into 'failed' — an ambiguous
// outcome (app crash, lost connection mid-sequence) must never leave
// a row silently stuck as "reserved" forever, and must never be
// quietly re-served to the next cycle either.
async function sweepStaleReservations(model, lotNo) {
  const cutoff = new Date(Date.now() - STALE_RESERVATION_MS);
  await pool.query(
    `UPDATE model_piece_queue
        SET status = 'failed'
      WHERE model = ? AND lot_no = ? AND status = 'reserved' AND reserved_at < ?`,
    [model, lotNo, cutoff]
  );
}

async function getVariableNames(modelConditionId) {
  const [rows] = await pool.query(
    `SELECT condition_name FROM model_condition_item
      WHERE model_condition_id = ? AND is_variable = 1
      ORDER BY condition_name`,
    [modelConditionId]
  );
  return rows.map((r) => r.condition_name);
}

// Every OTHER model_condition row sharing (model, lot_no), with its
// own sorted per-piece condition-name list — used both to validate a
// save (guardVariableConditions) and to resolve a queue's canonical
// variable_names for display.
async function getSiblingVariableSets(model, lotNo, excludeId) {
  const params = excludeId ? [model, lotNo, excludeId] : [model, lotNo];
  const [rows] = await pool.query(
    `SELECT id, job_no, pallet_no FROM model_condition
      WHERE model = ? AND lot_no = ?${excludeId ? ' AND id != ?' : ''}`,
    params
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [items] = await pool.query(
    `SELECT model_condition_id, condition_name FROM model_condition_item
      WHERE model_condition_id IN (?) AND is_variable = 1
      ORDER BY condition_name`,
    [ids]
  );
  const byId = {};
  items.forEach((it) => { (byId[it.model_condition_id] ||= []).push(it.condition_name); });
  return rows.map((r) => ({
    id: r.id,
    job_no: r.job_no,
    pallet_no: r.pallet_no,
    names: (byId[r.id] || []).slice().sort(),
  }));
}

async function getCounts(model, lotNo) {
  const [rows] = await pool.query(
    `SELECT status, COUNT(*) AS n FROM model_piece_queue WHERE model = ? AND lot_no = ? GROUP BY status`,
    [model, lotNo]
  );
  const counts = { pending: 0, reserved: 0, marked: 0, failed: 0, total: 0 };
  rows.forEach((r) => {
    const n = Number(r.n) || 0;
    counts[r.status] = n;
    counts.total += n;
  });
  return counts;
}

// The queue's canonical variable names = whichever sibling model_condition
// currently has per-piece conditions ticked (they're enforced to all
// match by guardVariableConditions, so the first one found is authoritative).
async function getVariableNamesForLot(model, lotNo) {
  const [rows] = await pool.query('SELECT id FROM model_condition WHERE model = ? AND lot_no = ?', [model, lotNo]);
  for (const r of rows) {
    const names = await getVariableNames(r.id);
    if (names.length) return names;
  }
  return [];
}

// ---------------- GET /api/piece-queue?model=&lot_no= ----------------
async function getQueue(req, res) {
  const model = trimmed(req.query.model);
  const lotNo = trimmed(req.query.lot_no);
  if (!model || !lotNo) return res.status(400).json({ error: 'model and lot_no are required.' });

  try {
    await sweepStaleReservations(model, lotNo);

    const variable_names = await getVariableNamesForLot(model, lotNo);
    const counts = await getCounts(model, lotNo);
    const [nextRows] = await pool.query(
      `SELECT seq_no, piece_values FROM model_piece_queue
        WHERE model = ? AND lot_no = ? AND status = 'pending'
        ORDER BY seq_no ASC LIMIT 3`,
      [model, lotNo]
    );

    // Which model_condition rows (pallet/job) currently share this queue.
    const [sharedBy] = await pool.query(
      `SELECT id, job_no, pallet_no FROM model_condition WHERE model = ? AND lot_no = ? ORDER BY pallet_no`,
      [model, lotNo]
    );

    return res.json({
      model,
      lot_no: lotNo,
      variable_names,
      shared_by: sharedBy,
      counts,
      next: nextRows.map((r) => ({ seq_no: r.seq_no, values: parseValues(r.piece_values) })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error fetching per-piece queue.' });
  }
}

// ---------------- POST /api/piece-queue/import ----------------
// Body: { model, lot_no, columns: string[], rows: string[][], dry_run? }
async function importQueue(req, res) {
  const { model: rawModel, lot_no: rawLot, columns, rows, dry_run } = req.body || {};
  const model = trimmed(rawModel);
  const lotNo = trimmed(rawLot);

  try {
    if (!model || !lotNo) return res.status(400).json({ error: 'model and lot_no are required.' });

    const variableNames = await getVariableNamesForLot(model, lotNo);
    if (variableNames.length === 0) {
      return res.status(400).json({
        error: `No model on "${model}" Lot "${lotNo}" has a Per-piece condition ticked. Tick "Per-piece" on a condition and save the model(s) first.`,
      });
    }

    if (!Array.isArray(columns) || !Array.isArray(rows)) {
      return res.status(400).json({ error: 'columns and rows are required.' });
    }
    if (rows.length === 0) return res.status(400).json({ error: 'The CSV has no data rows.' });
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
    if (unknown.length) headerErrors.push(`Unknown column(s): ${unknown.join(', ')}. Expected: ${variableNames.join(', ')}.`);
    const missing = variableNames.filter((n) => !seen.has(n));
    if (missing.length) headerErrors.push(`Missing column(s): ${missing.join(', ')}.`);
    if (headerErrors.length) {
      return res.status(400).json({ error: headerErrors[0], errors: headerErrors, error_count: headerErrors.length });
    }

    // ---- rows ----
    const parsed = [];
    const errors = [];
    let errorCount = 0;
    const addError = (msg) => { errorCount += 1; if (errors.length < MAX_REPORTED_ERRORS) errors.push(msg); };

    rows.forEach((r, idx) => {
      const line = idx + 2;
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

    const warnings = [];
    const seenKeys = new Set();
    let dupes = 0;
    parsed.forEach((o) => {
      const key = JSON.stringify(variableNames.map((n) => o[n]));
      if (seenKeys.has(key)) dupes += 1;
      else seenKeys.add(key);
    });
    if (dupes > 0) warnings.push(`${dupes} row(s) repeat an earlier row exactly — the same content would be marked more than once.`);

    const existing = await getCounts(model, lotNo);
    if (existing.reserved > 0) {
      return res.status(409).json({
        error: `${existing.reserved} piece(s) are currently reserved (marking in progress on one of the pallets sharing this lot). Wait for them to finish before replacing the queue.`,
      });
    }

    const [sharedBy] = await pool.query(
      `SELECT id, job_no, pallet_no FROM model_condition WHERE model = ? AND lot_no = ? ORDER BY pallet_no`,
      [model, lotNo]
    );

    const summary = {
      ok: true,
      model,
      lot_no: lotNo,
      variable_names: variableNames,
      shared_by: sharedBy,
      total: parsed.length,
      preview: parsed.slice(0, PREVIEW_ROWS),
      warnings,
      will_replace: existing,
    };

    if (dry_run) return res.json({ ...summary, dry_run: true });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [reservedRows] = await conn.query(
        `SELECT COUNT(*) AS n FROM model_piece_queue WHERE model = ? AND lot_no = ? AND status = 'reserved' FOR UPDATE`,
        [model, lotNo]
      );
      if (reservedRows[0].n > 0) {
        await conn.rollback();
        return res.status(409).json({ error: 'A piece was reserved while importing. Try again in a moment.' });
      }

      await conn.query('DELETE FROM model_piece_queue WHERE model = ? AND lot_no = ?', [model, lotNo]);

      for (let i = 0; i < parsed.length; i += INSERT_CHUNK) {
        const chunk = parsed
          .slice(i, i + INSERT_CHUNK)
          .map((o, j) => [model, lotNo, i + j + 1, JSON.stringify(o)]);
        await conn.query(
          'INSERT INTO model_piece_queue (model, lot_no, seq_no, piece_values) VALUES ?',
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
      targetType: 'piece_queue',
      targetId: `${model}::${lotNo}`,
      description: `Imported ${parsed.length} per-piece row(s) for "${model}" (Lot ${lotNo}), shared by ${sharedBy.map((s) => `${s.pallet_no}/Job ${s.job_no}`).join(', ')}, replacing ${existing.total} old row(s)`,
      details: { total: parsed.length, columns: variableNames, model, lot_no: lotNo, shared_by: sharedBy, replaced: existing, warnings },
    });

    return res.status(201).json({ ...summary, dry_run: false, imported: parsed.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error importing per-piece values.' });
  }
}

// ---------------- DELETE /api/piece-queue?model=&lot_no= ----------------
async function clearQueue(req, res) {
  const model = trimmed(req.query.model);
  const lotNo = trimmed(req.query.lot_no);
  if (!model || !lotNo) return res.status(400).json({ error: 'model and lot_no are required.' });

  try {
    const existing = await getCounts(model, lotNo);
    if (existing.reserved > 0) {
      return res.status(409).json({ error: 'A piece is reserved (marking in progress). Wait for it to finish first.' });
    }
    await pool.query('DELETE FROM model_piece_queue WHERE model = ? AND lot_no = ?', [model, lotNo]);

    await systemLog.logAction({
      req,
      action: 'model.queue_clear',
      targetType: 'piece_queue',
      targetId: `${model}::${lotNo}`,
      description: `Cleared per-piece queue for "${model}" (Lot ${lotNo}) (${existing.total} row(s), ${existing.pending} unmarked)`,
      details: { model, lot_no: lotNo, cleared: existing },
    });

    return res.json({ cleared: existing.total });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error clearing per-piece queue.' });
  }
}

// ---------------- POST /api/piece-queue/reserve ----------------
// Body: { model, lot_no, model_condition_id, pallet_no }
// Locks the next pending row for THIS pallet's cycle. Returns the row
// (id + values) so the caller can substitute it into the per-piece
// condition's CharacterString before sending WX,JOB=...
async function reserveNext(req, res) {
  const { model: rawModel, lot_no: rawLot, model_condition_id, pallet_no } = req.body || {};
  const model = trimmed(rawModel);
  const lotNo = trimmed(rawLot);
  if (!model || !lotNo) return res.status(400).json({ error: 'model and lot_no are required.' });
  if (!['Pallet1', 'Pallet2'].includes(pallet_no)) return res.status(400).json({ error: "pallet_no must be 'Pallet1' or 'Pallet2'." });

  try {
    await sweepStaleReservations(model, lotNo);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [rows] = await conn.query(
        `SELECT id, seq_no, piece_values FROM model_piece_queue
          WHERE model = ? AND lot_no = ? AND status = 'pending'
          ORDER BY seq_no ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [model, lotNo]
      );

      if (!rows.length) {
        await conn.rollback();
        return res.status(409).json({
          error: `No per-piece values left in the queue for "${model}" (Lot ${lotNo}). Load a new CSV before continuing.`,
        });
      }

      const row = rows[0];
      await conn.query(
        `UPDATE model_piece_queue
            SET status = 'reserved', reserved_by_user_id = ?, reserved_model_condition_id = ?,
                reserved_pallet_no = ?, reserved_at = NOW()
          WHERE id = ?`,
        [req.user ? req.user.id : null, model_condition_id || null, pallet_no, row.id]
      );
      await conn.commit();

      return res.json({
        queue_id: row.id,
        seq_no: row.seq_no,
        values: parseValues(row.piece_values),
      });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error reserving a per-piece row.' });
  }
}

// ---------------- POST /api/piece-queue/:queueId/release ----------------
// Cycle failed BEFORE marking (door/pallet/laser interlock, job select
// failed, etc.) — the row goes back to pending so it's tried again next
// cycle, nothing was lost.
async function releaseReserved(req, res) {
  const { queueId } = req.params;
  try {
    const [result] = await pool.query(
      `UPDATE model_piece_queue
          SET status = 'pending', reserved_by_user_id = NULL, reserved_model_condition_id = NULL,
              reserved_pallet_no = NULL, reserved_at = NULL
        WHERE id = ? AND status = 'reserved'`,
      [queueId]
    );
    if (result.affectedRows === 0) {
      return res.status(409).json({ error: 'That row is not currently reserved (already released, marked, or failed).' });
    }
    return res.json({ released: Number(queueId) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error releasing per-piece row.' });
  }
}

// ---------------- POST /api/piece-queue/:queueId/fail ----------------
// Outcome is ambiguous (e.g. StartMarking sent but connection lost
// before a reply came back — the part MAY have been marked with this
// serial, so it must never be silently re-served to another part).
async function failReserved(req, res) {
  const { queueId } = req.params;
  const { reason } = req.body || {};
  try {
    const [result] = await pool.query(
      `UPDATE model_piece_queue SET status = 'failed' WHERE id = ? AND status = 'reserved'`,
      [queueId]
    );
    if (result.affectedRows === 0) {
      return res.status(409).json({ error: 'That row is not currently reserved (already released, marked, or failed).' });
    }
    await systemLog.logAction({
      req,
      action: 'model.queue_row_failed',
      targetType: 'piece_queue',
      targetId: String(queueId),
      description: `Per-piece queue row #${queueId} marked failed (ambiguous outcome)${reason ? `: ${reason}` : ''}`,
      details: { queue_id: Number(queueId), reason: reason || null },
      status: 'failed',
    });
    return res.json({ failed: Number(queueId) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error failing per-piece row.' });
  }
}

// ---------------- middleware: POST / PUT /api/models ----------------
function readIncomingConditions(body) {
  let c = body && body.conditions;
  if (typeof c === 'string') {
    try { c = JSON.parse(c); } catch (e) { c = []; }
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

    const model = trimmed(req.body.model);
    const lotNo = trimmed(req.body.lot_no);
    const sortedIncoming = names.slice().sort();

    // ---- 1. Sibling consistency: every OTHER model_condition row
    // sharing (model, lot_no) must tick the SAME per-piece names. ----
    if (model && lotNo) {
      const siblings = await getSiblingVariableSets(model, lotNo, req.params.id || null);
      const mismatched = siblings.filter((s) => JSON.stringify(s.names) !== JSON.stringify(sortedIncoming));
      if (mismatched.length) {
        const list = mismatched
          .map((s) => `Job ${String(s.job_no).padStart(4, '0')}/${s.pallet_no} (per-piece: ${s.names.length ? s.names.join(', ') : 'none'})`)
          .join('; ');
        return reject(
          409,
          `Per-piece condition names must match every job sharing "${model}" Lot "${lotNo}" — this job wants [${sortedIncoming.join(', ') || 'none'}], but mismatched with: ${list}.`
        );
      }
    }

    if (!req.params.id) return next(); // POST: nothing queued yet for this row

    // ---- 2. In-flight queue protection: if THIS row's own per-piece
    // names are changing, and the shared (model, lot_no) queue still
    // has pending/reserved rows, block until the queue is cleared. ----
    const currentNames = (await getVariableNames(req.params.id)).slice().sort();
    if (JSON.stringify(currentNames) !== JSON.stringify(sortedIncoming) && model && lotNo) {
      const [cnt] = await pool.query(
        `SELECT COUNT(*) AS n FROM model_piece_queue WHERE model = ? AND lot_no = ? AND status IN ('pending','reserved')`,
        [model, lotNo]
      );
      const active = Number(cnt[0].n) || 0;
      if (active > 0) {
        return reject(
          409,
          `"${model}" Lot "${lotNo}" still has ${active} unmarked per-piece row(s) in its shared queue. Clear the queue (or finish the lot) before changing which conditions are per-piece.`
        );
      }
    }

    return next();
  } catch (e) {
    console.error(e);
    return reject(500, 'Server error checking per-piece conditions.');
  }
}

module.exports = {
  getQueue,
  importQueue,
  clearQueue,
  reserveNext,
  releaseReserved,
  failReserved,
  guardVariableConditions,
};