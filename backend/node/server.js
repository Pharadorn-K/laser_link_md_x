// backend/node/server.js
const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./routes/auth.routes');
const usersRoutes = require('./routes/users.routes');
const equipmentRoutes = require('./routes/equipment.routes');
const modelRoutes = require('./routes/model.routes');
const systemLogRoutes = require('./routes/systemLog.routes');
const productionRoutes = require('./routes/production.routes'); // NEW

const app = express();

app.use(cors());
app.use(express.json());

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/equipment', equipmentRoutes);
app.use('/api/models', modelRoutes);
app.use('/api/system-log', systemLogRoutes);
app.use('/api/production', productionRoutes); // NEW

app.get('/api/health', (req, res) => res.json({ ok: true }));

const frontendDir = path.join(__dirname, '..', '..', 'frontend');
app.use(express.static(frontendDir));

app.get('/', (req, res) => res.sendFile(path.join(frontendDir, 'login.html')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`laser_link_md_x API gateway listening on port ${PORT}`);
});