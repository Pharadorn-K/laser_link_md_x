// ============================================================
// Auth + user-management controller
//   Sign-up  : employee_id, name, password (+ optional photo) -> status='pending'
//   Sign-in  : employee_id + password, only if status='approved'
//   Approve  : admin only, flips status pending -> approved/rejected
//   Profile  : each user can update their own name / password / photo
// ============================================================
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
require('dotenv').config();

const SALT_ROUNDS = 10;

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
    const { employee_id, name, password } = req.body;
    if (!employee_id || !name || !password) {
      return res.status(400).json({ error: 'employee_id, name and password are required.' });
    }

    const [existing] = await pool.query('SELECT id FROM users WHERE employee_id = ?', [employee_id]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Employee ID already registered.' });
    }

    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const photo_path = req.file ? `/uploads/photos/${req.file.filename}` : null;

    const [result] = await pool.query(
      `INSERT INTO users (employee_id, name, password_hash, photo_path, role, status)
       VALUES (?, ?, ?, ?, 'user', 'pending')`,
      [employee_id, name, password_hash, photo_path]
    );

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
      return res.status(401).json({ error: 'Invalid employee ID or password.' });
    }
    const user = rows[0];

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid employee ID or password.' });
    }

    if (user.status === 'pending') {
      return res.status(403).json({ error: 'Your account is awaiting admin approval.' });
    }
    if (user.status === 'rejected') {
      return res.status(403).json({ error: 'Your account request was rejected. Contact an admin.' });
    }

    const token = signToken(user);
    return res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error during sign in.' });
  }
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

    if (name) {
      fields.push('name = ?');
      values.push(name);
    }
    if (password) {
      const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
      fields.push('password_hash = ?');
      values.push(password_hash);
    }
    if (req.file) {
      fields.push('photo_path = ?');
      values.push(`/uploads/photos/${req.file.filename}`);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    values.push(req.user.id);
    await pool.query(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);

    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
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
  await pool.query('UPDATE users SET status = ? WHERE id = ?', [status, id]);
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
  if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });
  return res.json(publicUser(rows[0]));
}

// ---------------- Admin: change role ----------------
async function setUserRole(req, res) {
  const { id } = req.params;
  const { role } = req.body; // 'admin' | 'user'
  if (!['admin', 'user'].includes(role)) {
    return res.status(400).json({ error: "role must be 'admin' or 'user'." });
  }
  await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
  if (rows.length === 0) return res.status(404).json({ error: 'User not found.' });
  return res.json(publicUser(rows[0]));
}

module.exports = {
  signup,
  signin,
  me,
  updateProfile,
  listUsers,
  setUserStatus,
  setUserRole,
};
