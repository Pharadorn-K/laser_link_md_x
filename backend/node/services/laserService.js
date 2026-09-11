// backend/node/services/laserService.js
const axios = require('axios');
require('dotenv').config();

const BASE = process.env.PYTHON_SERVICE_URL || 'http://localhost:5000';

// Marking (especially StartMarking) can legitimately take a long time
// on real hardware — waiting for camera/2D-code checks etc. The old
// 20s timeout was fine while these were 500ms stubs; now it can cut
// off a request the Python service is still faithfully processing.
const client = axios.create({ baseURL: BASE, timeout: 90000 });

async function forward(method, path, data) {
  try {
    const res = await client.request({ method, url: path, data });
    return { status: res.status, data: res.data };
  } catch (err) {
    if (err.response) {
      return { status: err.response.status, data: err.response.data };
    }
    return { status: 502, data: { error: `Cannot reach Python equipment service: ${err.message}` } };
  }
}

module.exports = { forward };