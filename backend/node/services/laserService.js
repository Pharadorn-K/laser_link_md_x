// ============================================================
// Bridge to backend/python (laser_marker_service.py Flask API)
// Node stays the single frontend-facing API; it forwards
// equipment calls to the Python service and returns the result.
// ============================================================
const axios = require('axios');
require('dotenv').config();

const BASE = process.env.PYTHON_SERVICE_URL || 'http://localhost:5000';

const client = axios.create({ baseURL: BASE, timeout: 20000 });

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
