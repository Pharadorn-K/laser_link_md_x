// backend/node/middleware/equipmentCommandPolicy.js
// ============================================================
// Command policy for POST /api/equipment/raw
//   admin / engineer          -> any command (raw tester, Command Browser)
//   machine_controller / operator -> ONLY the exact commands the
//        Start Marking sequences send (allowlist below), and the
//        laser ip/port is pinned server-side (client values ignored).
//   Everyone: control characters (\r \n etc.) are rejected so a
//   value can't smuggle a second command onto the wire.
// Denied attempts are written to system_log.
// ============================================================
const systemLog = require('../services/systemLog.service');

const PRIVILEGED_ROLES = ['admin', 'engineer'];
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

const PARAM = '[^,\\x00-\\x1f\\x7f]+';
const ALLOWED_COMMANDS = [
  /^RX,Ready$/,
  /^WX,JobNo=\d{4}$/,
  /^WX,JOB=\d{4},BLK=\d{3},CharacterString=[^\x00-\x1f\x7f]{1,255}$/,
  /^WX,StartMarking=1$/,
  new RegExp(`^WX,Check2DCode5=(?:${PARAM},){16}${PARAM}$`), // 17 params A-Q
  /^RX,CodeReadResult=[01]$/,
];

async function restrictRawCommand(req, res, next) {
  req.body = req.body || {};
  const command = typeof req.body.command === 'string' ? req.body.command.trim() : '';

  if (!command) {
    return res.status(400).json({ error: 'command is required.' });
  }
  if (CONTROL_CHARS.test(command)) {
    return res.status(400).json({ error: 'command contains invalid control characters.' });
  }

  req.body.command = command;

  if (PRIVILEGED_ROLES.includes(req.user.role)) return next();

  if (!ALLOWED_COMMANDS.some((re) => re.test(command))) {
    await systemLog.logAction({
      req,
      action: 'equipment.raw_command_denied',
      targetType: 'equipment',
      description: `Blocked non-allowlisted command from ${req.user.role}: ${command.slice(0, 200)}`,
      details: { command },
      status: 'failed',
    });
    return res.status(403).json({ error: 'That command is not permitted for your role.' });
  }

  // Non-privileged callers never choose the laser address.
  // Python falls back to its own configured ip/port.
  delete req.body.ip;
  delete req.body.port;
  return next();
}

module.exports = { restrictRawCommand };