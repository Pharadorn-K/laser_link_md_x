# backend/python/io_service.py
from flask import Flask, jsonify, request
from flask_cors import CORS
from io_core import IOClient, IOError_

app = Flask(__name__)
CORS(app)
_client = IOClient()


@app.get("/api/io/status")
def status():
    try:
        return jsonify({"ok": True, **_client.status_snapshot()})
    except IOError_ as e:
        return jsonify({"ok": False, "error": str(e)}), 502


@app.post("/api/io/front-door")
def front_door():
    data = request.get_json(force=True) or {}
    action = data.get("action")
    try:
        if action == "open":
            _client.open_front_door()
        elif action == "close":
            _client.close_front_door()
        else:
            return jsonify({"ok": False, "error": "action must be 'open' or 'close'."}), 400
        return jsonify({"ok": True})
    except IOError_ as e:
        return jsonify({"ok": False, "error": str(e)}), 502


@app.post("/api/io/swap-pallets")
def swap_pallets():
    logs = []
    try:
        _client.swap_pallets(log_fn=lambda m: logs.append(m))
        return jsonify({"ok": True, "log": logs})
    except IOError_ as e:
        return jsonify({"ok": False, "error": str(e), "log": logs}), 502


@app.post("/api/io/call-pallet/<int:pallet_no>")
def call_pallet(pallet_no):
    return swap_pallets()  # mechanism is coupled — same underlying action


@app.post("/api/io/change-pallet")
def change_pallet():
    return swap_pallets()


@app.post("/api/io/alarm-reset/<axis>")
def alarm_reset(axis):
    if axis not in ("pallet1", "pallet2", "frontdoor"):
        return jsonify({"ok": False, "error": "axis must be pallet1, pallet2, or frontdoor."}), 400
    try:
        _client.reset_axis_alarm(axis)
        return jsonify({"ok": True})
    except IOError_ as e:
        return jsonify({"ok": False, "error": str(e)}), 502


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True, use_reloader=False, threaded=True)