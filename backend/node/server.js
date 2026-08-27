// backend/node/server.js
// ============================================================
// laser_link_md_x API gateway
//   - Serves the frontend (static files)
//   - Handles auth / user approval (MySQL, this file's own domain)
//   - Proxies equipment/laser calls to the Python service
// ============================================================
const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./routes/auth.routes');
const usersRoutes = require('./routes/users.routes');
const equipmentRoutes = require('./routes/equipment.routes');
const modelRoutes = require('./routes/model.routes');

const app = express();

app.use(cors());
app.use(express.json());

// Uploaded profile / signup photos
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---- API routes ----
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/equipment', equipmentRoutes);
app.use('/api/models', modelRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---- Serve frontend (SPA) ----
const frontendDir = path.join(__dirname, '..', '..', 'frontend');
app.use(express.static(frontendDir));

app.get('/', (req, res) => res.sendFile(path.join(frontendDir, 'login.html')));

// Fallback 404 for unknown API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`laser_link_md_x API gateway listening on port ${PORT}`);
});
