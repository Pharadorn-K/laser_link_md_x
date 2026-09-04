// backend/node/controllers/auth.controller.js
// ============================================================
// Auth + user-management controller
//   Sign-up  : employee_id, name, password (+ optional photo) -> status='pending'
//   Sign-in  : employee_id + password, only if status='approved'
//   Sign-out : logs the event only (JWT is stateless — token is just dropped client-side)
//   Approve  : admin only, flips status pending -> approved/rejected
//   Profile  : each user can update their own name / password / photo
//   Every meaningful action is recorded to system_log via systemLog.service.
// ============================================================
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const systemLog = require('../services/systemLog.service');
require('dotenv').config();

const SALT_ROUNDS = 10;

const SIGNUP_ROLES = ['operator', 'machine_controller', 'engineer']; // never 'admin' — that account already exists
const ASSIGNABLE_ROLES = ['operator', 'machine_controller', 'engineer']; // admin can't be granted via API either

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      employee_id: user.employee_id,
      name: user.name,
      role: user.role,
      status: user.status,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}

function publicUser(u) {
  return {
    id: u.id,
    employee_id: u.employee_id,
    name: u.name,
    photo_path: u.photo_path,
    role: u.role,
    status: u.status,
    created_at: u.created_at,
  };
}

// ---------------- Sign up ----------------
async function signup(req, res) {
  try {
    const { employee_id, name, password, role } = req.body;
    if (!employee_id || !name || !password || !role) {
      return res.status(400).json({ error: 'employee_id, name, password and role are required.' });
    }
    if (!SIGNUP_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${SIGNUP_ROLES.join(', ')}.` });
    }

    const [existing] = await pool.query('SELECT id FROM users WHERE employee_id = ?', [employee_id]);
    if (existing.length > 0) {
      await systemLog.logAction({
        req,
        user: { employee_id, name, role },
        action: 'auth.signup',
        targetType: 'user',
        description: `Signup rejected: employee ID "${employee_id}" already registered`,
        status: 'failed',
      });
      return res.status(409).json({ error: 'Employee ID already registered.' });
    }

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const photo_path = req.file ? `/uploads/photos/${req.file.filename}` : null;

    const [result] = await pool.query(
      `INSERT INTO users (employee_id, name, password_hash, photo_path, role, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [employee_id, name, password_hash, photo_path, role]
    );

    await systemLog.logAction({
      req,
      user: { id: result.insertId, employee_id, name, role },
      action: 'auth.signup',
      targetType: 'user',
      targetId: result.insertId,
      description: `New account requested: ${name} (${employee_id}), role ${role}`,
      details: { role },
    });

    return res.status(201).json({
      message: 'Account created. Please wait for admin approval before signing in.',
      id: result.insertId,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error during sign up.' });
  }
}

// ---------------- Sign in ----------------
async function signin(req, res) {
  try {
    const { employee_id, password } = req.body;
    if (!employee_id || !password) {
      return res.status(400).json({ error: 'employee_id and password are required.' });
    }

    const [rows] = await pool.query('SELECT * FROM users WHERE employee_id = ?', [employee_id]);
    if (rows.length === 0) {
      await systemLog.logAction({
        req,
        user: { employee_id },
        action: 'auth.signin',
        description: `Sign-in failed: unknown employee ID "${employee_id}"`,
        status: 'failed',
      });
      return res.status(401).json({ error: 'Invalid employee ID or password.' });
    }
    const user = rows[0];

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      await systemLog.logAction({
        req,
        user,
        action: 'auth.signin',
        description: `Sign-in failed: incorrect password for ${user.name} (${user.employee_id})`,
        status: 'failed',
      });
      return res.status(401).json({ error: 'Invalid employee ID or password.' });
    }

    if (user.status === 'pending') {
      await systemLog.logAction({
        req,
        user,
        action: 'auth.signin',
        description: `Sign-in blocked: ${user.name} (${user.employee_id}) is pending approval`,
        status: 'failed',
      });
      return res.status(403).json({ error: 'Your account is awaiting admin approval.' });
    }
    if (user.status === 'rejected') {
      await systemLog.logAction({
        req,
        user,
        action: 'auth.signin',
        description: `Sign-in blocked: ${user.name} (${user.employee_id}) was rejected`,
        status: 'failed',
      });
      return res.status(403).json({ error: 'Your account request was rejected. Contact an admin.' });
    }

    const token = signToken(user);

    await systemLog.logAction({
      req,
      user,
      action: 'auth.signin',
      description: `${user.name} (${user.employee_id}) signed in`,
    });

    return res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error during sign in.' });
  }
}

// ---------------- Sign out ----------------
// JWT is stateless — nothing to invalidate server-side. This just
// records the event; the client drops the token immediately after.
async function signout(req, res) {
  await systemLog.logAction({
    req,
    action: 'auth.signout',
    description: `${req.user.name} (${req.user.employee_id}) signed out`,
  });
  return res.json({ ok: true });
}

// ---------------- Current user ----------------
async function me(req, res) {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });
  return res.json(publicUser(rows[0]));
}

// ---------------- Profile update (self) ----------------
async function updateProfile(req, res) {
  try {
    const { name, password } = req.body;
    const fields = [];
    const values = [];
    const changed = [];

    if (name) {
      fields.push('name = ?');
      values.push(name);
      changed.push('name');
    }
    if (password) {
      const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
      fields.push('password_hash = ?');
      values.push(password_hash);
      changed.push('password'); // never log the actual value
    }
    if (req.file) {
      fields.push('photo_path = ?');
      values.push(`/uploads/photos/${req.file.filename}`);
      changed.push('photo');
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    values.push(req.user.id);
    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);

    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);

    await systemLog.logAction({
      req,
      action: 'auth.profile_update',
      targetType: 'user',
      targetId: req.user.id,
      description: `${req.user.name} updated their profile (${changed.join(', ')})`,
      details: { changed },
    });

    return res.json(publicUser(rows[0]));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error updating profile.' });
  }
}

// ---------------- Admin: list users ----------------
async function listUsers(req, res) {
  const { status } = req.query; // optional filter e.g. ?status=pending
  let sql = 'SELECT * FROM users';
  const params = [];
  if (status) {
    sql += ' WHERE status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC';
  const [rows] = await pool.query(sql, params);
  return res.json(rows.map(publicUser));
}

// ---------------- Admin: approve / reject ----------------
async function setUserStatus(req, res) {
  const { id } = req.params;
  const { status } = req.body; // 'approved' | 'rejected' | 'pending'
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ error: "status must be 'approved', 'rejected' or 'pending'." });
  }

  const [beforeRows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
  if (beforeRows.length === 0) return res.status(404).json({ error: 'User not found.' });
  const before = beforeRows[0];

  await pool.query('UPDATE users SET status = ? WHERE id = ?', [status, id]);
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);

  await systemLog.logAction({
    req,
    action: 'user.status_change',
    targetType: 'user',
    targetId: id,
    description: `Set status of ${before.name} (${before.employee_id}) from "${before.status}" to "${status}"`,
    details: { from: before.status, to: status },
  });

  return res.json(publicUser(rows[0]));
}

// ---------------- Admin: change role ----------------
async function setUserRole(req, res) {
  const { id } = req.params;
  const { role } = req.body;
  if (!ASSIGNABLE_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ASSIGNABLE_ROLES.join(', ')}.` });
  }

  const [beforeRows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
  if (beforeRows.length === 0) return res.status(404).json({ error: 'User not found.' });
  const before = beforeRows[0];

  await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);

  await systemLog.logAction({
    req,
    action: 'user.role_change',
    targetType: 'user',
    targetId: id,
    description: `Changed role of ${before.name} (${before.employee_id}) from "${before.role}" to "${role}"`,
    details: { from: before.role, to: role },
  });

  return res.json(publicUser(rows[0]));
}

module.exports = {
  signup,
  signin,
  signout,
  me,
  updateProfile,
  listUsers,
  setUserStatus,
  setUserRole,
};