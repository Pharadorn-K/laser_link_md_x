# backend/python/io_core.py
"""
Modbus I/O bridge — 2 stations, per Sunstar Engineering wiring diagram
(New Laser Marking — IO Module, sheet 10).

Station 1 (LAN-3/HUB3): pallet cylinders, front door cylinder, lamps,
                          side-door status, laser alarm/warning inputs.
Station 2 (LAN-4/HUB4): dual-channel safety relay status, the dedicated
                          "Pallet 2 Down" limit switch, alarm reset in,
                          shutdown-IPC signal.

⚠️ ADDRESS CAVEAT: the wiring diagram tells us WHICH X/Y point each
signal is (e.g. X0.0 = BACKWARD COMP. PALLET1), but NOT which Modbus
coil/discrete-input NUMBER the gateway module assigns to that point.
Below assumes the common linear convention: X0.0->addr 0, X0.1->addr 1,
... X1.7->addr 15 (same for Y). CONFIRM against the I/O module's own
Modbus register-map manual — if it differs, only the numbers in
STATION1_DI / STATION1_COIL / STATION2_DI below need to change.

pip install pymodbus (add to requirements.txt)
"""
import time
from pymodbus.client import ModbusTcpClient

# ----------------------------------------------------------------------
# Station connections. For simulation: run test/modbus_server.py TWICE
# (two processes) — Port=5020 for Station 1, Port=5021 for Station 2.
# ----------------------------------------------------------------------
STATIONS = {
    1: {"ip": "127.0.0.1", "port": 5020, "unit_id": 1},
    2: {"ip": "127.0.0.1", "port": 5021, "unit_id": 1},
}

# ---- Station 1 discrete inputs (X0.0 .. X1.7 -> addr 0..15) ----
STATION1_DI = {
    "backward_comp_pallet1":       0,
    "forward_comp_pallet1":        1,
    "alarm_pallet1":                2,
    "backward_comp_pallet2":       3,
    "forward_comp_pallet2":        4,
    "alarm_pallet2":                5,
    "backward_comp_frontdoor":     6,
    "forward_comp_frontdoor":      7,
    "alarm_frontdoor":              8,
    "alarm_lasermark":              9,
    "warning_lasermark":           10,
    "two_hand":                    11,
    # 12 = SPARE
    "frontdoor_limit_left_close":  13,
    "frontdoor_limit_right_close": 14,
    "safety_door_side_close":      15,
}

# ---- Station 1 coils (Y0.0 .. Y1.7 -> addr 0..15) ----
STATION1_COIL = {
    "backward_command_pallet1":    0,
    "forward_command_pallet1":     1,
    "alarm_reset_pallet1":         2,
    "backward_command_pallet2":    3,
    "forward_command_pallet2":     4,
    "alarm_reset_pallet2":         5,
    "backward_command_frontdoor":  8,
    "forward_command_frontdoor":   9,
    "alarm_reset_frontdoor":      10,
    "alarm_reset_lasermark":      11,
    "side_safety_door_open":      12,
    "alarm_lamp_red":             13,
    "running_lamp_yellow":        14,
    "ready_lamp_green":           15,
}

# ---- Station 2 discrete inputs (X0.0 .. X0.4 -> addr 0..4) ----
STATION2_DI = {
    "safety_relay1_status": 0,
    "safety_relay2_status": 1,
    "alarm_reset_in":       2,
    "limit_pallet2_down":   3,
    "shutdown_ipc":         4,
}

WAIT_TIMEOUT_S = 20
POLL_INTERVAL_S = 0.25


class IOError_(Exception):
    pass


class IOClient:
    def __init__(self, stations=None):
        self.stations_cfg = stations or STATIONS
        self.clients = {}  # station number -> ModbusTcpClient

    def _client(self, station):
        if station not in self.clients or not self.clients[station].is_socket_open():
            cfg = self.stations_cfg[station]
            c = ModbusTcpClient(cfg["ip"], port=cfg["port"], timeout=5)
            if not c.connect():
                raise IOError_(f"Could not connect to Station {station} at {cfg['ip']}:{cfg['port']}")
            self.clients[station] = c
        return self.clients[station]

    def close(self):
        for c in self.clients.values():
            try:
                c.close()
            except Exception:
                pass
        self.clients = {}

    def _read_di(self, station, table, name):
        addr = table[name]
        client = self._client(station)
        rr = client.read_discrete_inputs(addr, 1)
        if rr.isError():
            raise IOError_(f"Read failed: Station{station}.{name} (addr {addr}): {rr}")
        return bool(rr.bits[0])

    def _write_coil(self, station, table, name, value):
        addr = table[name]
        client = self._client(station)
        rq = client.write_coil(addr, value)
        if rq.isError():
            raise IOError_(f"Write failed: Station{station}.{name} (addr {addr}): {rq}")

    def read_s1_di(self, name):
        return self._read_di(1, STATION1_DI, name)

    def write_s1_coil(self, name, value):
        self._write_coil(1, STATION1_COIL, name, value)

    def read_s2_di(self, name):
        return self._read_di(2, STATION2_DI, name)

    def wait_for(self, read_fn, expected, timeout=WAIT_TIMEOUT_S, poll=POLL_INTERVAL_S):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if read_fn() == expected:
                return True
            time.sleep(poll)
        return False

    # ---- Safety ----
    def is_side_door_safe(self):
        # Dual-channel safety relay (D4SL-N2FFA-D4) + the door's own
        # close-confirm switch — all three must agree the door is closed.
        return (
            self.read_s1_di("safety_door_side_close")
            and self.read_s2_di("safety_relay1_status")
            and self.read_s2_di("safety_relay2_status")
        )

    def check_axis_alarm(self, axis_name):
        alarm_map = {
            "pallet1": "alarm_pallet1",
            "pallet2": "alarm_pallet2",
            "frontdoor": "alarm_frontdoor",
        }
        return self.read_s1_di(alarm_map[axis_name])

    def reset_axis_alarm(self, axis_name):
        reset_map = {
            "pallet1": "alarm_reset_pallet1",
            "pallet2": "alarm_reset_pallet2",
            "frontdoor": "alarm_reset_frontdoor",
        }
        coil = reset_map[axis_name]
        self.write_s1_coil(coil, True)
        time.sleep(0.3)
        self.write_s1_coil(coil, False)

    # ---- Front door (IAI EC-R6H-250-3-WA) ----
    # ASSUMPTION: FORWARD = open, BACKWARD = close. Confirm/flip if wrong.
    def open_front_door(self):
        if self.check_axis_alarm("frontdoor"):
            raise IOError_("Front door axis has an active alarm — reset it first.")
        self.write_s1_coil("forward_command_frontdoor", True)
        ok = self.wait_for(lambda: self.read_s1_di("forward_comp_frontdoor"), True)
        self.write_s1_coil("forward_command_frontdoor", False)
        if not ok:
            raise IOError_("Front door did not confirm OPEN within timeout.")

    def close_front_door(self):
        if self.check_axis_alarm("frontdoor"):
            raise IOError_("Front door axis has an active alarm — reset it first.")
        self.write_s1_coil("backward_command_frontdoor", True)
        ok = self.wait_for(
            lambda: self.read_s1_di("frontdoor_limit_left_close") and self.read_s1_di("frontdoor_limit_right_close"),
            True,
        )
        self.write_s1_coil("backward_command_frontdoor", False)
        if not ok:
            raise IOError_("Front door did not confirm CLOSED (left+right limits) within timeout.")

    # ---- Pallet swap — the 5-step sequence you described ----
    # ASSUMPTION: BACKWARD = the "move down" direction for Pallet2's
    # first move, FORWARD = "move across" for both pallets afterward.
    # Confirm/flip if wrong — nothing else in the logic depends on it.
    def swap_pallets(self, log_fn=lambda msg: None):
        for axis in ("pallet1", "pallet2"):
            if self.check_axis_alarm(axis):
                raise IOError_(f"{axis} has an active alarm — reset it before swapping.")

        # Step 1: Pallet 2 moves down, freeing its old slot
        log_fn("Step 1: Pallet 2 moving down...")
        self.write_s1_coil("backward_command_pallet2", True)
        ok = self.wait_for(lambda: self.read_s2_di("limit_pallet2_down"), True)
        # Step 2: stop Pallet 2 regardless of outcome
        log_fn("Step 2: Stopping Pallet 2.")
        self.write_s1_coil("backward_command_pallet2", False)
        if not ok:
            raise IOError_("Pallet 2 did not confirm DOWN position within timeout.")

        # Step 3: Pallet 1 moves directly into the freed slot
        log_fn("Step 3: Pallet 1 moving across...")
        self.write_s1_coil("forward_command_pallet1", True)
        ok = self.wait_for(lambda: self.read_s1_di("forward_comp_pallet1"), True)
        # Step 4: stop Pallet 1
        log_fn("Step 4: Stopping Pallet 1.")
        self.write_s1_coil("forward_command_pallet1", False)
        if not ok:
            raise IOError_("Pallet 1 did not confirm end position within timeout.")

        # Step 5: Pallet 2 moves across and ramps back up to height
        log_fn("Step 5: Pallet 2 moving across and up...")
        self.write_s1_coil("forward_command_pallet2", True)
        ok = self.wait_for(lambda: self.read_s1_di("forward_comp_pallet2"), True)
        self.write_s1_coil("forward_command_pallet2", False)
        if not ok:
            raise IOError_("Pallet 2 did not confirm final UP position within timeout.")
        log_fn("Pallet swap complete.")

    # ---- Lamps (stack light) ----
    def set_lamps(self, red=False, yellow=False, green=False):
        self.write_s1_coil("alarm_lamp_red", red)
        self.write_s1_coil("running_lamp_yellow", yellow)
        self.write_s1_coil("ready_lamp_green", green)

    def status_snapshot(self):
        return {
            "side_door_safe": self.is_side_door_safe(),
            "safety_door_side_close": self.read_s1_di("safety_door_side_close"),
            "safety_relay1_status": self.read_s2_di("safety_relay1_status"),
            "safety_relay2_status": self.read_s2_di("safety_relay2_status"),
            "frontdoor_closed": (
                self.read_s1_di("frontdoor_limit_left_close")
                and self.read_s1_di("frontdoor_limit_right_close")
            ),
            "frontdoor_open": self.read_s1_di("forward_comp_frontdoor"),
            "alarm_pallet1": self.read_s1_di("alarm_pallet1"),
            "alarm_pallet2": self.read_s1_di("alarm_pallet2"),
            "alarm_frontdoor": self.read_s1_di("alarm_frontdoor"),
            "alarm_lasermark": self.read_s1_di("alarm_lasermark"),
            "warning_lasermark": self.read_s1_di("warning_lasermark"),
            "two_hand": self.read_s1_di("two_hand"),
            "shutdown_ipc_requested": self.read_s2_di("shutdown_ipc"),
        }