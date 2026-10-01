# test/modbus_server2.py
# ============================================================
# Station 2 simulator (LAN-4/HUB4): dual-channel safety relay
# status, the dedicated "Pallet 2 Down" limit switch, alarm reset
# in, shutdown-IPC signal. io_core.py never writes coils on this
# station, so this UI shows Discrete Inputs only.
# ============================================================
import tkinter as tk
from tkinter import ttk, scrolledtext
import threading
import socket
import struct
from datetime import datetime

# ---- Signal map (mirrors io_core.py's STATION2_DI) ----
STATION2_DI_LABELS = {
    0: "safety_relay1_status",
    1: "safety_relay2_status",
    2: "alarm_reset_in",
    3: "limit_pallet2_down",
    4: "shutdown_ipc",
}

# DI03 (limit_pallet2_down) is the confirm signal for
# backward_command_pallet2, but that coil lives on Station 1 — a
# separate process — so we can only leave an informational note here,
# not a verified confirmation.
CROSS_STATION_NOTE = {
    3: "This is the confirm signal for backward_command_pallet2 (DO03), "
       "which is commanded from Station 1 — cross-process, not auto-verified here.",
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


# ========== Modbus TCP Handler (protocol layer — unchanged) ==========
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
        addr = struct.unpack(">H", data[8:10])[0]
        count = struct.unpack(">H", data[10:12])[0]
        coils = self.ds.get_coils(addr, count)
        byte_count = (count + 7) // 8
        coil_bytes = bytearray(byte_count)
        for i, c in enumerate(coils):
            if c:
                coil_bytes[i // 8] |= (1 << (i % 8))
        return self._mbap(tid, uid, bytes([0x01, byte_count]) + bytes(coil_bytes))

    def _fc02(self, data, tid, uid):
        addr = struct.unpack(">H", data[8:10])[0]
        count = struct.unpack(">H", data[10:12])[0]
        di = self.ds.get_discrete_inputs(addr, count)
        byte_count = (count + 7) // 8
        di_bytes = bytearray(byte_count)
        for i, c in enumerate(di):
            if c:
                di_bytes[i // 8] |= (1 << (i % 8))
        self.log(f"[FC02] Read DI addr={addr} count={count} -> {list(di[:count])}")
        return self._mbap(tid, uid, bytes([0x02, byte_count]) + bytes(di_bytes))

    def _fc03(self, data, tid, uid):
        addr = struct.unpack(">H", data[8:10])[0]
        count = struct.unpack(">H", data[10:12])[0]
        regs = self.ds.get_holding_registers(addr, count)
        pdu = bytes([0x03, count * 2])
        for r in regs:
            pdu += struct.pack(">H", r)
        return self._mbap(tid, uid, pdu)

    def _fc04(self, data, tid, uid):
        addr = struct.unpack(">H", data[8:10])[0]
        count = struct.unpack(">H", data[10:12])[0]
        regs = self.ds.get_input_registers(addr, count)
        pdu = bytes([0x04, count * 2])
        for r in regs:
            pdu += struct.pack(">H", r)
        return self._mbap(tid, uid, pdu)

    def _fc05(self, data, tid, uid):
        addr = struct.unpack(">H", data[8:10])[0]
        value = struct.unpack(">H", data[10:12])[0]
        coil_val = (value == 0xFF00)
        self.ds.set_coils(addr, [coil_val])
        self.update_ui()
        return self._mbap(tid, uid, bytes([0x05]) + data[8:12])

    def _fc06(self, data, tid, uid):
        addr = struct.unpack(">H", data[8:10])[0]
        value = struct.unpack(">H", data[10:12])[0]
        self.ds.set_holding_registers(addr, [value])
        self.update_ui()
        return self._mbap(tid, uid, bytes([0x06]) + data[8:12])

    def _fc0F(self, data, tid, uid):
        addr = struct.unpack(">H", data[8:10])[0]
        count = struct.unpack(">H", data[10:12])[0]
        byte_count = data[12]
        coil_bytes = data[13:13 + byte_count]
        values = [bool((coil_bytes[i // 8] >> (i % 8)) & 1) for i in range(count)]
        self.ds.set_coils(addr, values)
        self.update_ui()
        return self._mbap(tid, uid, bytes([0x0F]) + data[8:12])

    def _fc10(self, data, tid, uid):
        addr = struct.unpack(">H", data[8:10])[0]
        count = struct.unpack(">H", data[10:12])[0]
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

    def show(self, _event=None):
        if self.tip or not self.text:
            return
        x = self.widget.winfo_rootx() + 20
        y = self.widget.winfo_rooty() + self.widget.winfo_height() + 6
        self.tip = tk.Toplevel(self.widget)
        self.tip.wm_overrideredirect(True)
        self.tip.wm_geometry(f"+{x}+{y}")
        tk.Label(self.tip, text=self.text, bg="#f9e2af", fg="#1e1e2e",
                 font=("Consolas", 9), padx=6, pady=3, relief=tk.SOLID, bd=1,
                 justify=tk.LEFT).pack()

    def hide(self, _event=None):
        if self.tip:
            self.tip.destroy()
            self.tip = None


class ModbusServerApp:
    STATION_LABEL = "Station 2 (LAN-4/HUB4)"

    def __init__(self, root):
        self.root = root
        self.root.title("Modbus TCP Server — Station 2 (safety relays / shutdown)")
        self.root.geometry("630x800")
        self.root.configure(bg="#1e1e2e")

        self.ds = ModbusDataStore()

        # ---- Preset: idle "already wired" machine state ----
        preset_di = {
            0: True,   # safety_relay1_status -> OK
            1: True,   # safety_relay2_status -> OK
            2: False,  # alarm_reset_in
            3: False,  # limit_pallet2_down (not mid-swap)
            4: False,  # shutdown_ipc
        }
        for addr, val in preset_di.items():
            self.ds.discrete_inputs[addr] = val

        self.server_thread = None
        self.running = False
        self.di_buttons = {}

        self.build_ui()

    def build_ui(self):
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TLabel", background="#1e1e2e", foreground="#cdd6f4")
        style.configure("TFrame", background="#1e1e2e")
        style.configure("TLabelframe", background="#1e1e2e", foreground="#89b4fa")
        style.configure("TLabelframe.Label", background="#1e1e2e", foreground="#89b4fa", font=("Arial", 10, "bold"))
        style.configure("TEntry", fieldbackground="#313244", foreground="#cdd6f4")

        ctrl = ttk.LabelFrame(self.root, text=f" Server Control — {self.STATION_LABEL} ", padding=10)
        ctrl.pack(fill=tk.X, padx=10, pady=5)

        ttk.Label(ctrl, text="IP:").grid(row=0, column=0, padx=5)
        self.ip_var = tk.StringVar(value="0.0.0.0")
        ttk.Entry(ctrl, textvariable=self.ip_var, width=15).grid(row=0, column=1, padx=5)

        ttk.Label(ctrl, text="Port:").grid(row=0, column=2, padx=5)
        self.port_var = tk.StringVar(value="5021")
        ttk.Entry(ctrl, textvariable=self.port_var, width=8).grid(row=0, column=3, padx=5)

        ttk.Label(ctrl, text="Unit ID:").grid(row=0, column=4, padx=5)
        self.uid_var = tk.StringVar(value="1")
        ttk.Entry(ctrl, textvariable=self.uid_var, width=5).grid(row=0, column=5, padx=5)

        self.start_btn = tk.Button(ctrl, text="Start Server", bg="#a6e3a1", fg="#1e1e2e",
                                    font=("Arial", 10, "bold"), command=self.start_server)
        self.start_btn.grid(row=0, column=6, padx=10)

        self.stop_btn = tk.Button(ctrl, text="Stop", bg="#f38ba8", fg="#1e1e2e",
                                   font=("Arial", 10, "bold"), command=self.stop_server, state=tk.DISABLED)
        self.stop_btn.grid(row=0, column=7, padx=5)

        self.status_lbl = tk.Label(ctrl, text="STOPPED", fg="#f38ba8", bg="#1e1e2e", font=("Arial", 10, "bold"))
        self.status_lbl.grid(row=0, column=8, padx=10)

        io_frame = ttk.LabelFrame(self.root, text=" Discrete Inputs (DI) — no coils used on this station ", padding=8)
        io_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)
        self.build_di_only_tab(io_frame)

        log_frame = ttk.LabelFrame(self.root, text=" Output Log ", padding=5)
        log_frame.pack(fill=tk.BOTH, expand=False, padx=10, pady=5)
        self.log_text = scrolledtext.ScrolledText(log_frame, height=10, bg="#181825", fg="#a6e3a1",
                                                    font=("Consolas", 9), insertbackground="white")
        self.log_text.pack(fill=tk.BOTH, expand=True)
        btn_f = tk.Frame(log_frame, bg="#1e1e2e")
        btn_f.pack(fill=tk.X)
        tk.Button(btn_f, text="Clear Log", bg="#313244", fg="#cdd6f4",
                  command=lambda: self.log_text.delete(1.0, tk.END)).pack(side=tk.RIGHT, padx=5)

    def build_di_only_tab(self, parent):
        ttk.Label(parent, text="Click a bit to toggle it. Hover any button for the full signal description.",
                  font=("Arial", 9)).pack(pady=(0, 6))

        wrap = tk.Frame(parent, bg="#1e1e2e")
        wrap.pack(fill=tk.BOTH, expand=True)

        tk.Label(wrap, text="Bit", bg="#313244", fg="#89b4fa", font=("Arial", 9, "bold"),
                 width=5, relief=tk.GROOVE).grid(row=0, column=0, padx=1, pady=1)
        tk.Label(wrap, text="Discrete Input (DI)", bg="#313244", fg="#a6e3a1", font=("Arial", 9, "bold"),
                 width=44, relief=tk.GROOVE).grid(row=0, column=1, padx=1, pady=1)

        for i in sorted(STATION2_DI_LABELS):
            r = i + 1
            name = STATION2_DI_LABELS[i]
            tk.Label(wrap, text=f"{i:02d}", bg="#1e1e2e", fg="#cdd6f4", width=5).grid(row=r, column=0, padx=1, pady=1)
            btn = tk.Button(wrap, text=f"DI{i:02d} -> {name}", width=42, anchor="w",
                             bg="#45475a", fg="#cdd6f4", command=lambda idx=i: self.toggle_di(idx))
            btn.grid(row=r, column=1, padx=1, pady=1, sticky="ew")
            tip = f"Discrete Input {i:02d}\nSignal: {name}\n{self.STATION_LABEL}"
            if i in CROSS_STATION_NOTE:
                tip += f"\nNote: {CROSS_STATION_NOTE[i]}"
            ToolTip(btn, tip)
            self.di_buttons[i] = btn

        self.refresh_di_ui()

    def toggle_di(self, idx):
        new_val = not self.ds.discrete_inputs[idx]
        self.ds.discrete_inputs[idx] = new_val
        name = STATION2_DI_LABELS.get(idx, f"di{idx}")
        self.log_msg(f"[UI] DI{idx:02d} ({name}) -> {'HIGH' if new_val else 'LOW'}")
        if idx in CROSS_STATION_NOTE and new_val:
            self.log_msg(f"    i  {CROSS_STATION_NOTE[idx]}")
        self.refresh_di_ui()

    def refresh_di_ui(self):
        for idx, btn in self.di_buttons.items():
            val = self.ds.discrete_inputs[idx]
            name = STATION2_DI_LABELS.get(idx, f"di{idx}")
            btn.config(text=f"DI{idx:02d} -> {name}  [{'HIGH' if val else 'low'}]",
                       bg="#89dceb" if val else "#45475a", fg="#1e1e2e" if val else "#cdd6f4")

    def update_all_ui(self):
        self.root.after(0, self.refresh_di_ui)

    def log_msg(self, msg):
        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        line = f"[{ts}] {msg}\n"
        self.root.after(0, lambda: (self.log_text.insert(tk.END, line), self.log_text.see(tk.END)))

    def start_server(self):
        self.running = True
        port = int(self.port_var.get())
        self.server_thread = threading.Thread(target=self._server_loop, args=(port,), daemon=True)
        self.server_thread.start()
        self.start_btn.config(state=tk.DISABLED)
        self.stop_btn.config(state=tk.NORMAL)
        self.status_lbl.config(text="RUNNING", fg="#a6e3a1")
        self.log_msg(f"[SERVER] Started on port {port}")

    def stop_server(self):
        self.running = False
        self.start_btn.config(state=tk.NORMAL)
        self.stop_btn.config(state=tk.DISABLED)
        self.status_lbl.config(text="STOPPED", fg="#f38ba8")
        self.log_msg("[SERVER] Stopped")

    def _server_loop(self, port):
        handler = ModbusTCPHandler(self.ds, self.log_msg, self.update_all_ui)
        try:
            server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server_sock.bind(("0.0.0.0", port))
            server_sock.listen(5)
            server_sock.settimeout(1.0)
            self.log_msg(f"[SERVER] Listening on 0.0.0.0:{port}")
            while self.running:
                try:
                    conn, addr = server_sock.accept()
                    self.log_msg(f"[CONNECT] Client {addr[0]}:{addr[1]}")
                    threading.Thread(target=self._client_handler, args=(conn, addr, handler), daemon=True).start()
                except socket.timeout:
                    continue
        except Exception as e:
            self.log_msg(f"[SERVER ERROR] {e}")
        finally:
            server_sock.close()

    def _client_handler(self, conn, addr, handler):
        try:
            conn.settimeout(None)
            while self.running:
                data = conn.recv(1024)
                if not data:
                    break
                response = handler.handle_request(data)
                if response:
                    conn.sendall(response)
        except Exception:
            pass
        finally:
            conn.close()
            self.log_msg(f"[DISCONNECT] {addr[0]}:{addr[1]}")


if __name__ == "__main__":
    root = tk.Tk()
    app = ModbusServerApp(root)
    root.mainloop()