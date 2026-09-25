# backend/python/io_core.py
"""
Modbus I/O bridge — 2 stations, per Sunstar Engineering wiring diagram
(New Laser Marking — IO Module, sheet 10).

Station 1 (LAN-3/HUB3): pallet cylinders, front door cylinder, lamps,
                          side-door status, laser alarm/warning inputs.
Station 2 (LAN-4/HUB4): dual-channel safety relay status, the dedicated
                          Pallet 2 "clear level" limit switch, alarm
                          reset in, shutdown-IPC signal.

------------------------------------------------------------------
SIGNAL MAP (confirmed)
------------------------------------------------------------------
Pallet position (both cylinders wired the same direction):
  DI00 (Station1) = LS0 Pallet1 -> ON = Pallet 1 in MACHINE room
  DI01 (Station1) = LS1 Pallet1 -> ON = Pallet 1 in OPERATOR room
  DI02 (Station1) = Pallet 1 alarm
  DI03 (Station1) = LS0 Pallet2 -> ON = Pallet 2 in MACHINE room
  DI04 (Station1) = LS1 Pallet2 -> ON = Pallet 2 in OPERATOR room
  DI05 (Station1) = Pallet 2 alarm
  DI00 & DI03 must NEVER both be ON (machine-room crash).
  DI01 & DI04 must NEVER both be ON (operator-room crash).

Front door (IAI EC-R6H-250-3-WA):
  FORWARD = CLOSE (confirmed by DI07 + DI13 + DI14)
  BACKWARD = OPEN  (confirmed by DI06)

Side door safety lock (D4SL-N2FFA-D4, NC contact):
  DI15 = ON  -> side door OPEN
  DI15 = OFF -> side door CLOSED (safe)
  (This is the inverse of what earlier revisions of this file assumed —
  fixed below.)

Pallet 2 "clear level" limit (Station 2):
  DI03 (Station2) = ON when Pallet 2's cylinder has stepped down ~10mm
  to clear the swap path ("clear part level"). It goes back OFF once
  Pallet 2 has returned to its ~150mm "working level".

⚠️ ADDRESS CAVEAT: the wiring diagram tells us WHICH X/Y point each
signal is, but NOT which Modbus coil/discrete-input NUMBER the gateway
module assigns to that point. Below assumes the common linear
convention: X0.0->addr 0 ... X1.7->addr 15 (same for Y). CONFIRM
against the I/O module's own Modbus register-map manual.

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
    "backward_comp_pallet1":       0,   # DI00 - Pallet1 in MACHINE room
    "forward_comp_pallet1":        1,   # DI01 - Pallet1 in OPERATOR room
    "alarm_pallet1":                2,   # DI02
    "backward_comp_pallet2":       3,   # DI03 - Pallet2 in MACHINE room
    "forward_comp_pallet2":        4,   # DI04 - Pallet2 in OPERATOR room
    "alarm_pallet2":                5,   # DI05
    "backward_comp_frontdoor":     6,   # DI06 - front door OPEN confirm
    "forward_comp_frontdoor":      7,   # DI07 - front door CLOSE confirm (1 of 3)
    "alarm_frontdoor":              8,   # DI08
    "alarm_lasermark":              9,   # DI09
    "warning_lasermark":           10,   # DI10
    "two_hand":                    11,   # DI11
    # 12 = SPARE
    "frontdoor_limit_left_close":  13,   # DI13 - front door CLOSE confirm (2 of 3)
    "frontdoor_limit_right_close": 14,   # DI14 - front door CLOSE confirm (3 of 3)
    "side_door_open":              15,   # DI15 - ON = OPEN, OFF = CLOSED (NC contact)
}

# ---- Station 1 coils (Y0.0 .. Y1.7 -> addr 0..15) ----
STATION1_COIL = {
    "backward_command_pallet1":    0,   # DO00 -> drive Pallet1 to MACHINE room
    "forward_command_pallet1":     1,   # DO01 -> drive Pallet1 to OPERATOR room
    "alarm_reset_pallet1":         2,   # DO02
    "backward_command_pallet2":    3,   # DO03 -> drive Pallet2 to MACHINE room
    "forward_command_pallet2":     4,   # DO04 -> drive Pallet2 to OPERATOR room
    "alarm_reset_pallet2":         5,   # DO05
    "backward_command_frontdoor":  8,   # DO08 -> front door OPEN
    "forward_command_frontdoor":   9,   # DO09 -> front door CLOSE
    "alarm_reset_frontdoor":      10,   # DO10
    "alarm_reset_lasermark":      11,   # DO11
    "side_safety_door_open":      12,   # DO12
    "alarm_lamp_red":             13,   # DO13
    "running_lamp_yellow":        14,   # DO14
    "ready_lamp_green":           15,   # DO15
}

# ---- Station 2 discrete inputs (X0.0 .. X0.4 -> addr 0..4) ----
STATION2_DI = {
    "safety_relay1_status": 0,   # DI00
    "safety_relay2_status": 1,   # DI01
    "alarm_reset_in":       2,   # DI02
    "limit_pallet2_down":   3,   # DI03 - Pallet2 "clear level" (transient, mid-swap only)
    "shutdown_ipc":         4,   # DI04
}

WAIT_TIMEOUT_S = 20
POLL_INTERVAL_S = 0.25


class IOError_(Exception):
    pass


class IOClient:
    def __init__(self, stations=None):
        self.stations_cfg = stations or STATIONS
        self.clients = {}  # station number -> ModbusTcpClient

    def _new_client(self, station):
        cfg = self.stations_cfg[station]
        c = ModbusTcpClient(cfg["ip"], port=cfg["port"], timeout=5)
        if not c.connect():
            raise IOError_(f"Could not connect to Station {station} at {cfg['ip']}:{cfg['port']}")
        return c

    def _client(self, station):
        if station not in self.clients or not self.clients[station].is_socket_open():
            self.clients[station] = self._new_client(station)
        return self.clients[station]

    def _drop_client(self, station):
        c = self.clients.pop(station, None)
        if c is not None:
            try:
                c.close()
            except Exception:
                pass

    def close(self):
        for station in list(self.clients.keys()):
            self._drop_client(station)

    def _read_di(self, station, table, name):
        addr = table[name]
        for attempt in (1, 2):
            client = self._client(station)
            try:
                rr = client.read_discrete_inputs(addr, 1)
                if rr.isError():
                    raise IOError_(f"Read failed: Station{station}.{name} (addr {addr}): {rr}")
                return bool(rr.bits[0])
            except IOError_:
                raise
            except Exception as e:
                # Connection was dropped by the peer (idle timeout, cable
                # blip, etc.) — the socket object didn't know it was dead
                # until this call failed. Drop it and retry ONCE with a
                # fresh connection before giving up.
                self._drop_client(station)
                if attempt == 2:
                    raise IOError_(
                        f"Read failed: Station{station}.{name} (addr {addr}) — "
                        f"connection lost and reconnect retry also failed: {e}"
                    )

    def _write_coil(self, station, table, name, value):
        addr = table[name]
        for attempt in (1, 2):
            client = self._client(station)
            try:
                rq = client.write_coil(addr, value)
                if rq.isError():
                    raise IOError_(f"Write failed: Station{station}.{name} (addr {addr}): {rq}")
                return
            except IOError_:
                raise
            except Exception as e:
                self._drop_client(station)
                if attempt == 2:
                    raise IOError_(
                        f"Write failed: Station{station}.{name} (addr {addr}) — "
                        f"connection lost and reconnect retry also failed: {e}"
                    )



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
        # D4SL-N2FFA-D4 dual-channel safety relay + the door's own NC
        # contact — DI15 ON means OPEN, so "safe" requires DI15 OFF,
        # plus both safety-relay channels healthy.
        return (
            not self.read_s1_di("side_door_open")
            and self.read_s2_di("safety_relay1_status")
            and self.read_s2_di("safety_relay2_status")
        )

    def is_frontdoor_closed(self):
        return (
            self.read_s1_di("forward_comp_frontdoor")
            and self.read_s1_di("frontdoor_limit_left_close")
            and self.read_s1_di("frontdoor_limit_right_close")
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
    # FORWARD = close (DO09), confirmed by DI07 + DI13 + DI14
    # BACKWARD = open (DO08), confirmed by DI06 only
    def open_front_door(self):
        if self.check_axis_alarm("frontdoor"):
            raise IOError_("Front door axis has an active alarm — reset it first.")
        self.write_s1_coil("backward_command_frontdoor", True)
        ok = self.wait_for(lambda: self.read_s1_di("backward_comp_frontdoor"), True)
        self.write_s1_coil("backward_command_frontdoor", False)
        if not ok:
            raise IOError_("Front door did not confirm OPEN (backward_comp_frontdoor) within timeout.")

    def close_front_door(self):
        if self.check_axis_alarm("frontdoor"):
            raise IOError_("Front door axis has an active alarm — reset it first.")
        self.write_s1_coil("forward_command_frontdoor", True)
        ok = self.wait_for(lambda: self.is_frontdoor_closed(), True)
        self.write_s1_coil("forward_command_frontdoor", False)
        if not ok:
            raise IOError_("Front door did not confirm CLOSED (forward_comp + both limits) within timeout.")

    # ---- Pallet state helper ----
    def pallet_state(self):
        return {
            "p1_machine": self.read_s1_di("backward_comp_pallet1"),   # DI00
            "p1_operator": self.read_s1_di("forward_comp_pallet1"),   # DI01
            "p1_alarm": self.read_s1_di("alarm_pallet1"),             # DI02
            "p2_machine": self.read_s1_di("backward_comp_pallet2"),   # DI03 (S1)
            "p2_operator": self.read_s1_di("forward_comp_pallet2"),   # DI04 (S1)
            "p2_alarm": self.read_s1_di("alarm_pallet2"),             # DI05
        }

    # ------------------------------------------------------------
    # CHANGE PALLET
    #
    # target_pallet: 1 or 2 — which pallet should end up in the
    # Operator Room when this call returns. The other pallet ends
    # up in the Machine Room.
    #
    #   target_pallet == 1  -> "Case 1": P1 Machine->Operator,
    #                                     P2 Operator->Machine
    #   target_pallet == 2  -> "Case 2": P1 Operator->Machine,
    #                                     P2 Machine->Operator
    #
    # Precondition for each case is the OTHER configuration already
    # being true — if the requested target is already in the
    # Operator Room, this is a no-op (returns current state).
    #
    # laser_ready_check: optional zero-arg callable returning
    # True/False. io_core has no visibility into the laser marker
    # itself, so if the caller wants "laser marker Ready" folded
    # into this interlock, pass a callback that checks it (e.g. an
    # RX,Ready poll). If omitted, only the IO-side interlocks
    # (front door, side door, pallet alarms) are enforced here.
    # ------------------------------------------------------------
    def change_pallet_to_operator(self, target_pallet, log_fn=lambda m: None, laser_ready_check=None):
        if target_pallet not in (1, 2):
            raise IOError_("target_pallet must be 1 or 2.")

        state = self.pallet_state()
        if target_pallet == 1 and state["p1_operator"]:
            log_fn("Pallet 1 already in Operator Room — no change needed.")
            return state
        if target_pallet == 2 and state["p2_operator"]:
            log_fn("Pallet 2 already in Operator Room — no change needed.")
            return state

        # ---- Step 1: Close front door ----
        log_fn("Step 1: Close front door.")
        self.close_front_door()

        # ---- Step 2: Pallet position + alarm precondition check ----
        state = self.pallet_state()
        if state["p1_alarm"] or state["p2_alarm"]:
            raise IOError_("Pallet 1 or Pallet 2 has an active alarm — cannot change pallet.")

        if target_pallet == 1:
            if not (state["p1_machine"] and state["p2_operator"]):
                raise IOError_(
                    "Case 1 precondition not met (expected P1 in Machine Room, "
                    f"P2 in Operator Room): P1 machine={state['p1_machine']}, "
                    f"P2 operator={state['p2_operator']}."
                )
        else:
            if not (state["p1_operator"] and state["p2_machine"]):
                raise IOError_(
                    "Case 2 precondition not met (expected P1 in Operator Room, "
                    f"P2 in Machine Room): P1 operator={state['p1_operator']}, "
                    f"P2 machine={state['p2_machine']}."
                )
        log_fn("Step 2: Pallet position + alarm check OK.")

        # ---- Step 3: Interlock check ----
        log_fn("Step 3: Interlock check (side door, front door, laser)...")
        if not self.is_side_door_safe():
            raise IOError_("Side door is not closed/safe — cannot change pallet.")
        if not self.is_frontdoor_closed():
            raise IOError_("Front door is not confirmed closed — cannot change pallet.")
        if laser_ready_check is not None and not laser_ready_check():
            raise IOError_("Laser marker is not Ready — cannot change pallet.")
        log_fn("Step 3: Interlock OK.")

        # ---- Steps 4-13: the actual swap ----
        if target_pallet == 1:
            self._run_case1(log_fn)
        else:
            self._run_case2(log_fn)

        # ---- Step 14: Open front door ----
        log_fn("Step 14: Open front door.")
        self.open_front_door()

        final = self.pallet_state()
        log_fn(f"Change pallet complete. P1 operator={final['p1_operator']} P2 operator={final['p2_operator']}.")
        return final

    def _run_case1(self, log_fn):
        # Case 1: Pallet1 Machine -> Operator, Pallet2 Operator -> Machine.
        # Pallet2's own cylinder does the down/up "clear path" motion
        # that lets Pallet1 slide across.
        log_fn("Step 4: Pallet 2 clearing down (DO03 ON).")
        self.write_s1_coil("backward_command_pallet2", True)
        ok = self.wait_for(lambda: self.read_s2_di("limit_pallet2_down"), True)
        log_fn("Step 6: Stopping Pallet 2 clear move (DO03 OFF).")
        self.write_s1_coil("backward_command_pallet2", False)
        if not ok:
            raise IOError_("Pallet 2 did not confirm clear-level position (DI03 Station2) within timeout.")

        log_fn("Step 7: Pallet 1 moving to Operator Room (DO01 ON).")
        self.write_s1_coil("forward_command_pallet1", True)
        ok = self.wait_for(lambda: self.read_s1_di("forward_comp_pallet1"), True)
        log_fn("Step 9: Stopping Pallet 1 (DO01 OFF).")
        self.write_s1_coil("forward_command_pallet1", False)
        if not ok:
            raise IOError_("Pallet 1 did not confirm Operator Room position (DI01) within timeout.")

        log_fn("Step 10: Pallet 2 moving up into Machine Room (DO03 ON).")
        self.write_s1_coil("backward_command_pallet2", True)
        ok = self.wait_for(lambda: self.read_s1_di("backward_comp_pallet2"), True)
        log_fn("Step 12: Stopping Pallet 2 (DO03 OFF).")
        self.write_s1_coil("backward_command_pallet2", False)
        if not ok:
            raise IOError_("Pallet 2 did not confirm Machine Room position (DI03 Station1) within timeout.")

        log_fn("Step 13: Recheck final position...")
        if not (self.read_s1_di("forward_comp_pallet1") and self.read_s1_di("backward_comp_pallet2")):
            raise IOError_("Final position check failed: expected P1 in Operator Room, P2 in Machine Room.")
        log_fn("Step 13: OK — P1 Operator Room, P2 Machine Room.")

    def _run_case2(self, log_fn):
        # Case 2: Pallet1 Operator -> Machine, Pallet2 Machine -> Operator.
        log_fn("Step 4: Pallet 2 clearing down (DO04 ON).")
        self.write_s1_coil("forward_command_pallet2", True)
        ok = self.wait_for(lambda: self.read_s2_di("limit_pallet2_down"), True)
        log_fn("Step 6: Stopping Pallet 2 clear move (DO04 OFF).")
        self.write_s1_coil("forward_command_pallet2", False)
        if not ok:
            raise IOError_("Pallet 2 did not confirm clear-level position (DI03 Station2) within timeout.")

        log_fn("Step 7: Pallet 1 moving to Machine Room (DO00 ON).")
        self.write_s1_coil("backward_command_pallet1", True)
        ok = self.wait_for(lambda: self.read_s1_di("backward_comp_pallet1"), True)
        log_fn("Step 9: Stopping Pallet 1 (DO00 OFF).")
        self.write_s1_coil("backward_command_pallet1", False)
        if not ok:
            raise IOError_("Pallet 1 did not confirm Machine Room position (DI00) within timeout.")

        log_fn("Step 10: Pallet 2 moving up into Operator Room (DO04 ON).")
        self.write_s1_coil("forward_command_pallet2", True)
        ok = self.wait_for(lambda: self.read_s1_di("forward_comp_pallet2"), True)
        log_fn("Step 12: Stopping Pallet 2 (DO04 OFF).")
        self.write_s1_coil("forward_command_pallet2", False)
        if not ok:
            raise IOError_("Pallet 2 did not confirm Operator Room position (DI04) within timeout.")

        log_fn("Step 13: Recheck final position...")
        if not (self.read_s1_di("backward_comp_pallet1") and self.read_s1_di("forward_comp_pallet2")):
            raise IOError_("Final position check failed: expected P1 in Machine Room, P2 in Operator Room.")
        log_fn("Step 13: OK — P1 Machine Room, P2 Operator Room.")

    # ---- Lamps (stack light) ----
    def set_lamps(self, red=False, yellow=False, green=False):
        self.write_s1_coil("alarm_lamp_red", red)
        self.write_s1_coil("running_lamp_yellow", yellow)
        self.write_s1_coil("ready_lamp_green", green)

    def status_snapshot(self):
        pallets = self.pallet_state()
        return {
            "side_door_safe": self.is_side_door_safe(),
            "side_door_open": self.read_s1_di("side_door_open"),
            "safety_relay1_status": self.read_s2_di("safety_relay1_status"),
            "safety_relay2_status": self.read_s2_di("safety_relay2_status"),
            "frontdoor_closed": self.is_frontdoor_closed(),
            "frontdoor_open": self.read_s1_di("backward_comp_frontdoor"),
            "alarm_frontdoor": self.read_s1_di("alarm_frontdoor"),
            "pallet1_in_machine_room": pallets["p1_machine"],
            "pallet1_in_operator_room": pallets["p1_operator"],
            "alarm_pallet1": pallets["p1_alarm"],
            "pallet2_in_machine_room": pallets["p2_machine"],
            "pallet2_in_operator_room": pallets["p2_operator"],
            "alarm_pallet2": pallets["p2_alarm"],
            "pallet2_clearing": self.read_s2_di("limit_pallet2_down"),
            "alarm_lasermark": self.read_s1_di("alarm_lasermark"),
            "warning_lasermark": self.read_s1_di("warning_lasermark"),
            "two_hand": self.read_s1_di("two_hand"),
            "shutdown_ipc_requested": self.read_s2_di("shutdown_ipc"),
        }