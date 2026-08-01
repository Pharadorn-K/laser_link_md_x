"""
laser_marker_service.py
------------------------
Flask REST wrapper around laser_core.py (LaserClient, COMMAND_GROUPS,
format_param) so the equipment page (frontend) and the Node API gateway
can drive the MD-X2520A laser marker over HTTP instead of through the
old Tkinter desktop app.

Endpoints
  GET    /api/commands        -> the full COMMAND_GROUPS tree (for the
                                  Command Browser dropdowns on the front end)
  GET    /api/status          -> connection info, recent log lines, queue
  POST   /api/connect         -> {ip, port} test connection (RX,Ready)
  POST   /api/raw             -> {ip, port, command} send one raw command
  POST   /api/command         -> alias of /api/raw (kept for future use)
  GET    /api/queue           -> list queued/processing jobs
  POST   /api/queue           -> {ip, port, program_no} add job to queue
  DELETE /api/queue/<id>      -> remove one pending job
  DELETE /api/queue           -> clear all pending (non-processing) jobs

The queue behaves exactly like the original app: jobs run one after
another in a background thread, waiting for READY, selecting the job,
then triggering StartMarking, with automatic retry on transient "busy"
responses.
"""
import itertools
import threading
import time

from flask import Flask, jsonify, request
from flask_cors import CORS

from laser_core import (
    COMMAND_GROUPS,
    LaserClient,
    LaserError,
    format_param,
    LASER_IP_DEFAULT,
    LASER_PORT_DEFAULT,
)

app = Flask(__name__)
CORS(app)

MAX_LOG_LINES = 500

# ----------------------------------------------------------------------
# Global state (single-device controller; one queue for the whole app)
# ----------------------------------------------------------------------
class EquipmentState:
    def __init__(self):
        self.lock = threading.Lock()
        self.ip = LASER_IP_DEFAULT
        self.port = LASER_PORT_DEFAULT
        self.connected = False
        self.client = None
        self.log_lines = []
        self.pending = []
        self._id_counter = itertools.count(1)
        self.wake_event = threading.Event()
        self.stop_event = threading.Event()

    def log(self, message):
        ts = time.strftime("%H:%M:%S")
        with self.lock:
            self.log_lines.append(f"[{ts}] {message}")
            if len(self.log_lines) > MAX_LOG_LINES:
                self.log_lines = self.log_lines[-MAX_LOG_LINES:]

    def ensure_client(self, ip, port):
        with self.lock:
            if self.client is None or self.ip != ip or self.port != port:
                if self.client is not None:
                    self.client.close()
                self.client = LaserClient(ip, port)
                self.ip = ip
                self.port = port
            return self.client

    def snapshot_queue(self):
        with self.lock:
            return [dict(it) for it in self.pending]


state = EquipmentState()


def _worker_loop():
    """Background thread: runs pending jobs one at a time, forever."""
    while not state.stop_event.is_set():
        item = None
        with state.lock:
            for it in state.pending:
                if it["status"] == "pending":
                    it["status"] = "processing"
                    item = it
                    break

        if item is None:
            state.wake_event.wait(timeout=0.5)
            state.wake_event.clear()
            continue

        state.log(f"--- Starting Job {item['program_no']:04d} ---")
        try:
            client = state.ensure_client(item["ip"], item["port"])
            client.run_job(item["program_no"], state.log)
            item["status"] = "done"
            state.connected = True
            state.log(f"--- Job {item['program_no']:04d} complete ---")
        except LaserError as e:
            item["status"] = "failed"
            state.log(f"!!! Job {item['program_no']:04d} FAILED: {e}")
        except Exception as e:  # noqa: BLE001
            item["status"] = "failed"
            state.connected = False
            state.log(f"!!! Unexpected error on Job {item['program_no']:04d}: {e}")
        finally:
            with state.lock:
                state.pending = [it for it in state.pending if it["status"] != "done"]


worker_thread = threading.Thread(target=_worker_loop, daemon=True)
worker_thread.start()


# ----------------------------------------------------------------------
# Routes
# ----------------------------------------------------------------------
@app.get("/api/commands")
def get_commands():
    return jsonify(COMMAND_GROUPS)


@app.get("/api/status")
def get_status():
    with state.lock:
        log_tail = list(state.log_lines[-200:])
        ip, port, connected = state.ip, state.port, state.connected
    return jsonify({
        "connection": {"ip": ip, "port": port, "connected": connected},
        "log": log_tail,
        "queue": state.snapshot_queue(),
    })


@app.post("/api/connect")
def connect():
    data = request.get_json(force=True) or {}
    ip = str(data.get("ip", LASER_IP_DEFAULT)).strip()
    try:
        port = int(data.get("port", LASER_PORT_DEFAULT))
    except (TypeError, ValueError):
        return jsonify({"error": "Port must be a number."}), 400

    state.log(f">>> [connect] testing {ip}:{port} (RX,Ready)")
    try:
        c = LaserClient(ip, port, timeout=10)
        response = c.send_raw("RX,Ready")
        c.close()
        state.ip, state.port, state.connected = ip, port, True
        state.log(f"<<< [connect] {response}")
        return jsonify({"connected": True, "response": response})
    except Exception as e:  # noqa: BLE001
        state.connected = False
        state.log(f"!!! [connect] error: {e}")
        return jsonify({"connected": False, "error": str(e)}), 502


def _send_raw_command(ip, port, command):
    state.log(f">>> [cmd] {command}")
    try:
        c = LaserClient(ip, port, timeout=15)
        response = c.send_raw(command)
        c.close()
        state.log(f"<<< [cmd] {response}")
        return {"ok": True, "response": response}, 200
    except Exception as e:  # noqa: BLE001
        state.log(f"!!! [cmd] error: {e}")
        return {"ok": False, "error": str(e)}, 502


@app.post("/api/raw")
def raw_command():
    data = request.get_json(force=True) or {}
    ip = str(data.get("ip", state.ip)).strip()
    command = str(data.get("command", "")).strip()
    try:
        port = int(data.get("port", state.port))
    except (TypeError, ValueError):
        return jsonify({"error": "Port must be a number."}), 400
    if not command:
        return jsonify({"error": "command is required."}), 400

    body, status = _send_raw_command(ip, port, command)
    return jsonify(body), status


@app.post("/api/command")
def command_alias():
    # Kept as a distinct endpoint for future use (e.g. server-side
    # template + format_param building); currently the front end builds
    # the full command string client-side and calls /api/raw directly.
    return raw_command()


@app.get("/api/queue")
def list_queue():
    return jsonify(state.snapshot_queue())


@app.post("/api/queue")
def add_to_queue():
    data = request.get_json(force=True) or {}
    ip = str(data.get("ip", state.ip)).strip()
    try:
        port = int(data.get("port", state.port))
        program_no = int(data.get("program_no"))
    except (TypeError, ValueError):
        return jsonify({"error": "program_no (and port) must be numbers."}), 400
    if not (0 <= program_no <= 1999):
        return jsonify({"error": "program_no must be between 0 and 1999."}), 400

    item = {
        "id": next(state._id_counter),
        "program_no": program_no,
        "ip": ip,
        "port": port,
        "status": "pending",
    }
    with state.lock:
        state.pending.append(item)
    state.log(f"Added Job {program_no:04d} to queue.")
    state.wake_event.set()
    return jsonify(item), 201


@app.delete("/api/queue/<int:job_id>")
def remove_from_queue(job_id):
    with state.lock:
        target = next((it for it in state.pending if it["id"] == job_id), None)
        if target is None:
            return jsonify({"error": "Job not found."}), 404
        if target["status"] == "processing":
            return jsonify({"error": "That job is currently running and cannot be removed."}), 409
        state.pending = [it for it in state.pending if it["id"] != job_id]
    return jsonify({"removed": job_id})


@app.delete("/api/queue")
def clear_queue():
    with state.lock:
        state.pending = [it for it in state.pending if it["status"] == "processing"]
    return jsonify({"cleared": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True, use_reloader=False)
