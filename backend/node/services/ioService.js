// backend/node/services/ioService.js
const axios = require('axios');
require('dotenv').config();

const BASE = process.env.IO_SERVICE_URL || 'http://localhost:5001';
const client = axios.create({ baseURL: BASE, timeout: 20000 });

async function forward(method, path, data) {
  try {
    const res = await client.request({ method, url: path, data });
    return { status: res.status, data: res.data };
  } catch (err) {
    if (err.response) return { status: err.response.status, data: err.response.data };
    return { status: 502, data: { error: `Cannot reach I/O service: ${err.message}` } };
  }
}

module.exports = { forward };