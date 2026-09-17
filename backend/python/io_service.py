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


def _run_change_pallet(target_pallet):
    logs = []
    try:
        final_state = _client.change_pallet_to_operator(target_pallet, log_fn=lambda m: logs.append(m))
        return jsonify({"ok": True, "log": logs, "state": final_state})
    except IOError_ as e:
        return jsonify({"ok": False, "error": str(e), "log": logs}), 502


@app.post("/api/io/change-pallet")
def change_pallet():
    data = request.get_json(force=True) or {}
    # Node sends {"target_pallet": 1|2} -- which pallet should end up
    # in the Operator Room.
    try:
        target = int(data.get("target_pallet"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "target_pallet (1 or 2) is required."}), 400
    if target not in (1, 2):
        return jsonify({"ok": False, "error": "target_pallet must be 1 or 2."}), 400
    return _run_change_pallet(target)


@app.post("/api/io/call-pallet/<int:pallet_no>")
def call_pallet(pallet_no):
    if pallet_no not in (1, 2):
        return jsonify({"ok": False, "error": "pallet_no must be 1 or 2."}), 400
    return _run_change_pallet(pallet_no)


# Kept for backward compatibility with any old caller that still hits
# this path with no target — just toggles based on current position.
@app.post("/api/io/swap-pallets")
def swap_pallets():
    try:
        state = _client.pallet_state()
    except IOError_ as e:
        return jsonify({"ok": False, "error": str(e), "log": []}), 502
    target = 1 if state["p2_operator"] else 2
    return _run_change_pallet(target)


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