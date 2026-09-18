# test/machine_simulator.py
# ============================================================
# Combined Station 1 (LAN-3/HUB3) + Station 2 (LAN-4/HUB4) Modbus
# simulator for the laser marking cell, with a "Simulate" panel:
# buttons that mimic the real confirm signal arriving after a
# command coil goes ON, so interlock testing doesn't require
# hand-toggling raw DI bits for every step.
#
# Run this INSTEAD of test/modbus_server1.py + test/modbus_server2.py
# — it replaces both (same signal maps, same default ports).
# ============================================================
import tkinter as tk
from tkinter import ttk, scrolledtext
import threading
import socket
import struct
from datetime import datetime

# ---- Signal maps (mirrors io_core.py) ----
STATION1_DI_LABELS = {
    0: "backward_comp_pallet1",
    1: "forward_comp_pallet1",
    2: "alarm_pallet1",
    3: "backward_comp_pallet2",
    4: "forward_comp_pallet2",
    5: "alarm_pallet2",
    6: "backward_comp_frontdoor",
    7: "forward_comp_frontdoor",
    8: "alarm_frontdoor",
    9: "alarm_lasermark",
    10: "warning_lasermark",
    11: "two_hand",
    13: "frontdoor_limit_left_close",
    14: "frontdoor_limit_right_close",
    15: "safety_door_side_open",
}

STATION1_COIL_LABELS = {
    0: "backward_command_pallet1",
    1: "forward_command_pallet1",
    2: "alarm_reset_pallet1",
    3: "backward_command_pallet2",
    4: "forward_command_pallet2",
    5: "alarm_reset_pallet2",
    8: "backward_command_frontdoor",
    9: "forward_command_frontdoor",
    10: "alarm_reset_frontdoor",
    11: "alarm_reset_lasermark",
    12: "side_safety_door_open",
    13: "alarm_lamp_red",
    14: "running_lamp_yellow",
    15: "ready_lamp_green",
}

STATION2_DI_LABELS = {
    0: "safety_relay1_status",
    1: "safety_relay2_status",
    2: "alarm_reset_in",
    3: "limit_pallet2_down",
    4: "shutdown_ipc",
}


# ========== Modbus Data Store ==========
class ModbusDataStore:
    def __init__(self):
        self.coils = [False] * 256
        self.discrete_inputs = [False] * 256
        self.holding_registers = [0] * 256
        self.input_registers = [0] * 256
        self.lock = threading.Lock()

    def get_coils(self, addr, count):
        with self.lock:
            return self.coils[addr:addr + count]

    def set_coils(self, addr, values):
        with self.lock:
            for i, v in enumerate(values):
                self.coils[addr + i] = bool(v)

    def get_discrete_inputs(self, addr, count):
        with self.lock:
            return self.discrete_inputs[addr:addr + count]

    def get_holding_registers(self, addr, count):
        with self.lock:
            return self.holding_registers[addr:addr + count]

    def set_holding_registers(self, addr, values):
        with self.lock:
            for i, v in enumerate(values):
                self.holding_registers[addr + i] = v & 0xFFFF

    def get_input_registers(self, addr, count):
        with self.lock:
            return self.input_registers[addr:addr + count]


# ========== Modbus TCP protocol handler (station-agnostic) ==========
class ModbusTCPHandler:
    def __init__(self, datastore, log_callback, update_callback):
        self.ds = datastore
        self.log = log_callback
        self.update_ui = update_callback

    def handle_request(self, data):
        if len(data) < 8:
            return None
        transaction_id = struct.unpack(">H", data[0:2])[0]
        unit_id = data[6]
        function_code = data[7]
        try:
            if function_code == 0x01:
                return self._fc01(data, transaction_id, unit_id)
            elif function_code == 0x02:
                return self._fc02(data, transaction_id, unit_id)
            elif function_code == 0x03:
                return self._fc03(data, transaction_id, unit_id)
            elif function_code == 0x04:
                return self._fc04(data, transaction_id, unit_id)
            elif function_code == 0x05:
                return self._fc05(data, transaction_id, unit_id)
            elif function_code == 0x06:
                return self._fc06(data, transaction_id, unit_id)
            elif function_code == 0x0F:
                return self._fc0F(data, transaction_id, unit_id)
            elif function_code == 0x10:
                return self._fc10(data, transaction_id, unit_id)
            else:
                return self._error_response(transaction_id, unit_id, function_code, 0x01)
        except Exception as e:
            self.log(f"[ERROR] FC={function_code:#04x}: {e}")
            return self._error_response(transaction_id, unit_id, function_code, 0x04)

    def _mbap(self, tid, uid, pdu):
        length = len(pdu) + 1
        return struct.pack(">HHH", tid, 0, length) + bytes([uid]) + pdu

    def _error_response(self, tid, uid, fc, ec):
        return self._mbap(tid, uid, bytes([fc | 0x80, ec]))

    def _fc01(self, data, tid, uid):
        addr, count = struct.unpack(">HH", data[8:12])
        coils = self.ds.get_coils(addr, count)
        byte_count = (count + 7) // 8
        buf = bytearray(byte_count)
        for i, c in enumerate(coils):
            if c:
                buf[i // 8] |= (1 << (i % 8))
        return self._mbap(tid, uid, bytes([0x01, byte_count]) + bytes(buf))

    def _fc02(self, data, tid, uid):
        addr, count = struct.unpack(">HH", data[8:12])
        di = self.ds.get_discrete_inputs(addr, count)
        byte_count = (count + 7) // 8
        buf = bytearray(byte_count)
        for i, c in enumerate(di):
            if c:
                buf[i // 8] |= (1 << (i % 8))
        return self._mbap(tid, uid, bytes([0x02, byte_count]) + bytes(buf))

    def _fc03(self, data, tid, uid):
        addr, count = struct.unpack(">HH", data[8:12])
        regs = self.ds.get_holding_registers(addr, count)
        pdu = bytes([0x03, count * 2])
        for r in regs:
            pdu += struct.pack(">H", r)
        return self._mbap(tid, uid, pdu)

    def _fc04(self, data, tid, uid):
        addr, count = struct.unpack(">HH", data[8:12])
        regs = self.ds.get_input_registers(addr, count)
        pdu = bytes([0x04, count * 2])
        for r in regs:
            pdu += struct.pack(">H", r)
        return self._mbap(tid, uid, pdu)

    def _fc05(self, data, tid, uid):
        addr = struct.unpack(">H", data[8:10])[0]
        value = struct.unpack(">H", data[10:12])[0]
        self.ds.set_coils(addr, [value == 0xFF00])
        self.update_ui()
        return self._mbap(tid, uid, bytes([0x05]) + data[8:12])

    def _fc06(self, data, tid, uid):
        addr = struct.unpack(">H", data[8:10])[0]
        value = struct.unpack(">H", data[10:12])[0]
        self.ds.set_holding_registers(addr, [value])
        self.update_ui()
        return self._mbap(tid, uid, bytes([0x06]) + data[8:12])

    def _fc0F(self, data, tid, uid):
        addr, count = struct.unpack(">HH", data[8:12])
        byte_count = data[12]
        coil_bytes = data[13:13 + byte_count]
        values = [bool((coil_bytes[i // 8] >> (i % 8)) & 1) for i in range(count)]
        self.ds.set_coils(addr, values)
        self.update_ui()
        return self._mbap(tid, uid, bytes([0x0F]) + data[8:12])

    def _fc10(self, data, tid, uid):
        addr, count = struct.unpack(">HH", data[8:12])
        values = [struct.unpack(">H", data[13 + i * 2:15 + i * 2])[0] for i in range(count)]
        self.ds.set_holding_registers(addr, values)
        self.update_ui()
        return self._mbap(tid, uid, bytes([0x10]) + data[8:12])


class ToolTip:
    def __init__(self, widget, text):
        self.widget = widget
        self.text = text
        self.tip = None
        widget.bind("<Enter>", self.show)
        widget.bind("<Leave>", self.hide)

    def show(self, _e=None):
        if self.tip or not self.text:
            return
        x = self.widget.winfo_rootx() + 20
        y = self.widget.winfo_rooty() + self.widget.winfo_height() + 6
        self.tip = tk.Toplevel(self.widget)
        self.tip.wm_overrideredirect(True)
        self.tip.wm_geometry(f"+{x}+{y}")
        tk.Label(self.tip, text=self.text, bg="#f9e2af", fg="#1e1e2e",
                 font=("Consolas", 9), padx=6, pady=3, relief=tk.SOLID, bd=1,
                 justify=tk.LEFT, wraplength=320).pack()

    def hide(self, _e=None):
        if self.tip:
            self.tip.destroy()
            self.tip = None


class TcpServer:
    """Runs one Modbus TCP listener in a background thread."""
    def __init__(self, port, handler, log_fn, label):
        self.port = port
        self.handler = handler
        self.log_fn = log_fn
        self.label = label
        self.running = False
        self.thread = None
        self.sock = None

    def start(self):
        self.running = True
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False

    def _loop(self):
        try:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.sock.bind(("0.0.0.0", self.port))
            self.sock.listen(5)
            self.sock.settimeout(1.0)
            self.log_fn(f"[{self.label}] Listening on 0.0.0.0:{self.port}")
            while self.running:
                try:
                    conn, addr = self.sock.accept()
                    self.log_fn(f"[{self.label}] Client connected {addr[0]}:{addr[1]}")
                    threading.Thread(target=self._client, args=(conn, addr), daemon=True).start()
                except socket.timeout:
                    continue
        except Exception as e:
            self.log_fn(f"[{self.label}] SERVER ERROR: {e}")
        finally:
            if self.sock:
                self.sock.close()

    def _client(self, conn, addr):
        try:
            conn.settimeout(None)
            while self.running:
                data = conn.recv(1024)
                if not data:
                    break
                resp = self.handler.handle_request(data)
                if resp:
                    conn.sendall(resp)
        except Exception:
            pass
        finally:
            conn.close()
            self.log_fn(f"[{self.label}] Client disconnected {addr[0]}:{addr[1]}")


# ============================================================
# SIMULATE ACTIONS — one entry per physical confirm signal.
# `ready(ds1, ds2)` decides whether the button is enabled (i.e. the
# command coil that would trigger this confirm is currently ON).
# `fire(ds1, ds2, log)` sets the DI(s) the way the real machine would
# once that motion completes.
# ============================================================
def _sim_actions():
    def front_opened_ready(ds1, ds2):
        return ds1.coils[8]  # backward_command_frontdoor (DO08)

    def front_opened_fire(ds1, ds2, log):
        ds1.discrete_inputs[6] = True    # backward_comp_frontdoor (DI06) ON
        ds1.discrete_inputs[7] = False   # forward_comp_frontdoor (DI07) OFF
        ds1.discrete_inputs[13] = False  # frontdoor_limit_left_close OFF
        ds1.discrete_inputs[14] = False  # frontdoor_limit_right_close OFF
        log("SIM: Front Door OPENED — DI06 ON, DI07/DI13/DI14 OFF")

    def front_closed_ready(ds1, ds2):
        return ds1.coils[9]  # forward_command_frontdoor (DO09)

    def front_closed_fire(ds1, ds2, log):
        ds1.discrete_inputs[7] = True
        ds1.discrete_inputs[13] = True
        ds1.discrete_inputs[14] = True
        ds1.discrete_inputs[6] = False
        log("SIM: Front Door CLOSED — DI07/DI13/DI14 ON, DI06 OFF")

    def p1_to_machine_ready(ds1, ds2):
        return ds1.coils[0]  # backward_command_pallet1 (DO00)

    def p1_to_machine_fire(ds1, ds2, log):
        ds1.discrete_inputs[0] = True
        ds1.discrete_inputs[1] = False
        log("SIM: Pallet 1 -> MACHINE room — DI00 ON, DI01 OFF")

    def p1_to_operator_ready(ds1, ds2):
        return ds1.coils[1]  # forward_command_pallet1 (DO01)

    def p1_to_operator_fire(ds1, ds2, log):
        ds1.discrete_inputs[1] = True
        ds1.discrete_inputs[0] = False
        log("SIM: Pallet 1 -> OPERATOR room — DI01 ON, DI00 OFF")

    def p2_clear_ready(ds1, ds2):
        return ds1.coils[3] or ds1.coils[4]  # backward/forward_command_pallet2

    def p2_clear_fire(ds1, ds2, log):
        ds2.discrete_inputs[3] = True  # limit_pallet2_down (Station2 DI03)
        log("SIM: Pallet 2 cleared down — Station2 DI03 ON (limit_pallet2_down)")

    def p2_to_machine_ready(ds1, ds2):
        return ds1.coils[3]  # backward_command_pallet2 (DO03)

    def p2_to_machine_fire(ds1, ds2, log):
        ds1.discrete_inputs[3] = True   # backward_comp_pallet2 (Station1 DI03)
        ds1.discrete_inputs[4] = False
        ds2.discrete_inputs[3] = False  # clear-level signal releases
        log("SIM: Pallet 2 -> MACHINE room — Station1 DI03 ON, DI04 OFF, Station2 DI03 OFF")

    def p2_to_operator_ready(ds1, ds2):
        return ds1.coils[4]  # forward_command_pallet2 (DO04)

    def p2_to_operator_fire(ds1, ds2, log):
        ds1.discrete_inputs[4] = True   # forward_comp_pallet2 (Station1 DI04)
        ds1.discrete_inputs[3] = False
        ds2.discrete_inputs[3] = False
        log("SIM: Pallet 2 -> OPERATOR room — Station1 DI04 ON, DI03 OFF, Station2 DI03 OFF")

    return [
        {"label": "Front Door Opened", "group": "Front Door",
         "desc": "Enabled when DO08 (backward_command_frontdoor) is ON.",
         "ready": front_opened_ready, "fire": front_opened_fire},
        {"label": "Front Door Closed", "group": "Front Door",
         "desc": "Enabled when DO09 (forward_command_frontdoor) is ON.",
         "ready": front_closed_ready, "fire": front_closed_fire},
        {"label": "Pallet 1 -> Machine Room", "group": "Pallet 1",
         "desc": "Enabled when DO00 (backward_command_pallet1) is ON.",
         "ready": p1_to_machine_ready, "fire": p1_to_machine_fire},
        {"label": "Pallet 1 -> Operator Room", "group": "Pallet 1",
         "desc": "Enabled when DO01 (forward_command_pallet1) is ON.",
         "ready": p1_to_operator_ready, "fire": p1_to_operator_fire},
        {"label": "Pallet 2 Cleared (down)", "group": "Pallet 2",
         "desc": "Enabled when DO03 or DO04 is ON. Fire this FIRST during a swap.",
         "ready": p2_clear_ready, "fire": p2_clear_fire},
        {"label": "Pallet 2 -> Machine Room", "group": "Pallet 2",
         "desc": "Enabled when DO03 (backward_command_pallet2) is ON. Fire AFTER 'Cleared (down)'.",
         "ready": p2_to_machine_ready, "fire": p2_to_machine_fire},
        {"label": "Pallet 2 -> Operator Room", "group": "Pallet 2",
         "desc": "Enabled when DO04 (forward_command_pallet2) is ON. Fire AFTER 'Cleared (down)'.",
         "ready": p2_to_operator_ready, "fire": p2_to_operator_fire},
    ]


class MachineSimulatorApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Laser Marking Cell — Machine Simulator (Station 1 + Station 2)")
        self.root.geometry("980x900")
        self.root.configure(bg="#1e1e2e")

        self.ds1 = ModbusDataStore()
        self.ds2 = ModbusDataStore()

        # ---- Preset idle state ----
        for addr, val in {0: True, 4: True, 7: True, 13: True, 14: True}.items():
            self.ds1.discrete_inputs[addr] = val
        for addr, val in {0: True, 1: True}.items():
            self.ds2.discrete_inputs[addr] = val

        self.server1 = None
        self.server2 = None
        self.di1_buttons = {}
        self.coil1_buttons = {}
        self.di2_buttons = {}
        self.sim_buttons = {}

        self.build_ui()
        self.start_servers()
        self.root.after(250, self._refresh_loop)

    # ---------------- UI ----------------
    def build_ui(self):
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TNotebook", background="#1e1e2e")
        style.configure("TFrame", background="#1e1e2e")
        style.configure("TLabel", background="#1e1e2e", foreground="#cdd6f4")

        ctrl = tk.Frame(self.root, bg="#1e1e2e")
        ctrl.pack(fill=tk.X, padx=10, pady=8)
        tk.Label(ctrl, text="Station 1 port:", bg="#1e1e2e", fg="#cdd6f4").pack(side=tk.LEFT)
        self.port1_var = tk.StringVar(value="5020")
        tk.Entry(ctrl, textvariable=self.port1_var, width=6).pack(side=tk.LEFT, padx=(4, 14))
        tk.Label(ctrl, text="Station 2 port:", bg="#1e1e2e", fg="#cdd6f4").pack(side=tk.LEFT)
        self.port2_var = tk.StringVar(value="5021")
        tk.Entry(ctrl, textvariable=self.port2_var, width=6).pack(side=tk.LEFT, padx=(4, 14))
        self.status_lbl = tk.Label(ctrl, text="STOPPED", fg="#f38ba8", bg="#1e1e2e", font=("Arial", 10, "bold"))
        self.status_lbl.pack(side=tk.LEFT, padx=10)
        tk.Button(ctrl, text="Start", bg="#a6e3a1", fg="#1e1e2e", font=("Arial", 10, "bold"),
                  command=self.start_servers).pack(side=tk.LEFT, padx=4)
        tk.Button(ctrl, text="Stop", bg="#f38ba8", fg="#1e1e2e", font=("Arial", 10, "bold"),
                  command=self.stop_servers).pack(side=tk.LEFT, padx=4)

        nb = ttk.Notebook(self.root)
        nb.pack(fill=tk.BOTH, expand=True, padx=10, pady=4)

        sim_tab = ttk.Frame(nb)
        io_tab = ttk.Frame(nb)
        nb.add(sim_tab, text="Simulate (step testing)")
        nb.add(io_tab, text="Raw I/O (manual bit toggle)")

        self.build_simulate_tab(sim_tab)
        self.build_io_tab(io_tab)

        log_frame = tk.LabelFrame(self.root, text=" Output Log ", bg="#1e1e2e", fg="#89b4fa")
        log_frame.pack(fill=tk.BOTH, expand=False, padx=10, pady=8)
        self.log_text = scrolledtext.ScrolledText(log_frame, height=10, bg="#181825", fg="#a6e3a1",
                                                    font=("Consolas", 9), insertbackground="white")
        self.log_text.pack(fill=tk.BOTH, expand=True)
        tk.Button(log_frame, text="Clear Log", bg="#313244", fg="#cdd6f4",
                  command=lambda: self.log_text.delete(1.0, tk.END)).pack(anchor="e", padx=4, pady=2)

    def build_simulate_tab(self, parent):
        tk.Label(parent, text="Buttons enable automatically once the matching command coil (DO) turns ON. "
                               "Click to feed back the confirm signal the real sensors would send.",
                 wraplength=900, justify=tk.LEFT).pack(anchor="w", padx=6, pady=(6, 10))

        actions = _sim_actions()
        groups = {}
        for a in actions:
            groups.setdefault(a["group"], []).append(a)

        for group_name, items in groups.items():
            box = tk.LabelFrame(parent, text=f" {group_name} ", bg="#1e1e2e", fg="#89b4fa",
                                 font=("Arial", 10, "bold"))
            box.pack(fill=tk.X, padx=8, pady=6)
            for a in items:
                row = tk.Frame(box, bg="#1e1e2e")
                row.pack(fill=tk.X, padx=6, pady=4)
                btn = tk.Button(row, text=a["label"], width=28, anchor="w",
                                 command=lambda act=a: self.run_sim(act))
                btn.pack(side=tk.LEFT)
                tk.Label(row, text=a["desc"], bg="#1e1e2e", fg="#9399b2",
                         font=("Arial", 9)).pack(side=tk.LEFT, padx=10)
                self.sim_buttons[a["label"]] = (btn, a)

    def build_io_tab(self, parent):
        wrap = tk.Frame(parent, bg="#1e1e2e")
        wrap.pack(fill=tk.BOTH, expand=True, padx=4, pady=4)

        tk.Label(wrap, text="Bit", bg="#313244", fg="#89b4fa", font=("Arial", 9, "bold"),
                 width=5, relief=tk.GROOVE).grid(row=0, column=0, padx=1, pady=1)
        tk.Label(wrap, text="Station 1 — DI (sensors)", bg="#313244", fg="#a6e3a1",
                 font=("Arial", 9, "bold"), width=32, relief=tk.GROOVE).grid(row=0, column=1, padx=1, pady=1)
        tk.Label(wrap, text="Station 1 — DO (commands)", bg="#313244", fg="#f38ba8",
                 font=("Arial", 9, "bold"), width=32, relief=tk.GROOVE).grid(row=0, column=2, padx=1, pady=1)
        tk.Label(wrap, text="Station 2 — DI", bg="#313244", fg="#89dceb",
                 font=("Arial", 9, "bold"), width=32, relief=tk.GROOVE).grid(row=0, column=3, padx=1, pady=1)

        max_rows = max(max(STATION1_DI_LABELS, default=-1), max(STATION1_COIL_LABELS, default=-1),
                        max(STATION2_DI_LABELS, default=-1)) + 1
        for i in range(max_rows):
            r = i + 1
            tk.Label(wrap, text=f"{i:02d}", bg="#1e1e2e", fg="#cdd6f4", width=5).grid(row=r, column=0, padx=1, pady=1)

            name = STATION1_DI_LABELS.get(i)
            if name:
                b = tk.Button(wrap, text=f"DI{i:02d} {name}", width=30, anchor="w", bg="#45475a", fg="#cdd6f4",
                               command=lambda idx=i: self.toggle_di(self.ds1, idx))
                b.grid(row=r, column=1, padx=1, pady=1, sticky="ew")
                self.di1_buttons[i] = b
            else:
                tk.Label(wrap, text="", bg="#1e1e2e", width=30).grid(row=r, column=1)

            name = STATION1_COIL_LABELS.get(i)
            if name:
                b = tk.Button(wrap, text=f"DO{i:02d} {name}", width=30, anchor="w", bg="#45475a", fg="#cdd6f4",
                               command=lambda idx=i: self.toggle_coil(self.ds1, idx))
                b.grid(row=r, column=2, padx=1, pady=1, sticky="ew")
                self.coil1_buttons[i] = b
            else:
                tk.Label(wrap, text="", bg="#1e1e2e", width=30).grid(row=r, column=2)

            name = STATION2_DI_LABELS.get(i)
            if name:
                b = tk.Button(wrap, text=f"DI{i:02d} {name}", width=30, anchor="w", bg="#45475a", fg="#cdd6f4",
                               command=lambda idx=i: self.toggle_di(self.ds2, idx))
                b.grid(row=r, column=3, padx=1, pady=1, sticky="ew")
                self.di2_buttons[i] = b
            else:
                tk.Label(wrap, text="", bg="#1e1e2e", width=30).grid(row=r, column=3)

    # ---------------- Actions ----------------
    def run_sim(self, action):
        if not action["ready"](self.ds1, self.ds2):
            self.log(f"[SIM] '{action['label']}' is not ready yet — its command coil is OFF.")
            return
        action["fire"](self.ds1, self.ds2, self.log)

    def toggle_di(self, ds, idx):
        ds.discrete_inputs[idx] = not ds.discrete_inputs[idx]
        self.log(f"[UI] DI{idx:02d} -> {'HIGH' if ds.discrete_inputs[idx] else 'LOW'}")

    def toggle_coil(self, ds, idx):
        ds.coils[idx] = not ds.coils[idx]
        self.log(f"[UI] DO{idx:02d} -> {'ON' if ds.coils[idx] else 'OFF'}")

    def log(self, msg):
        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        line = f"[{ts}] {msg}\n"
        self.root.after(0, lambda: (self.log_text.insert(tk.END, line), self.log_text.see(tk.END)))

    # ---------------- Servers ----------------
    def start_servers(self):
        self.stop_servers()
        h1 = ModbusTCPHandler(self.ds1, self.log, lambda: None)
        h2 = ModbusTCPHandler(self.ds2, self.log, lambda: None)
        self.server1 = TcpServer(int(self.port1_var.get()), h1, self.log, "Station1")
        self.server2 = TcpServer(int(self.port2_var.get()), h2, self.log, "Station2")
        self.server1.start()
        self.server2.start()
        self.status_lbl.config(text="RUNNING", fg="#a6e3a1")

    def stop_servers(self):
        if self.server1:
            self.server1.stop()
        if self.server2:
            self.server2.stop()
        self.status_lbl.config(text="STOPPED", fg="#f38ba8")

    # ---------------- Periodic UI refresh ----------------
    def _refresh_loop(self):
        for idx, btn in self.di1_buttons.items():
            val = self.ds1.discrete_inputs[idx]
            btn.config(bg="#89dceb" if val else "#45475a", fg="#1e1e2e" if val else "#cdd6f4")
        for idx, btn in self.coil1_buttons.items():
            val = self.ds1.coils[idx]
            btn.config(bg="#a6e3a1" if val else "#45475a", fg="#1e1e2e" if val else "#cdd6f4")
        for idx, btn in self.di2_buttons.items():
            val = self.ds2.discrete_inputs[idx]
            btn.config(bg="#89dceb" if val else "#45475a", fg="#1e1e2e" if val else "#cdd6f4")
        for label, (btn, action) in self.sim_buttons.items():
            ready = action["ready"](self.ds1, self.ds2)
            btn.config(state=tk.NORMAL if ready else tk.DISABLED,
                       bg="#f9e2af" if ready else "#313244",
                       fg="#1e1e2e" if ready else "#6c7086")
        self.root.after(250, self._refresh_loop)


if __name__ == "__main__":
    root = tk.Tk()
    app = MachineSimulatorApp(root)
    root.mainloop()