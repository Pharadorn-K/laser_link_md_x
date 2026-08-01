import tkinter as tk
from tkinter import ttk, scrolledtext
import threading
import socket
import struct
import time
from datetime import datetime

# ========== Modbus Data Store ==========
class ModbusDataStore:
    def __init__(self):
        self.coils = [False] * 256          # 0x coils (DO)
        self.discrete_inputs = [False] * 256 # 1x discrete inputs (DI)
        self.holding_registers = [0] * 256   # 4x holding registers
        self.input_registers = [0] * 256     # 3x input registers
        self.lock = threading.Lock()

    def get_coils(self, addr, count):
        with self.lock:
            return self.coils[addr:addr+count]

    def set_coils(self, addr, values):
        with self.lock:
            for i, v in enumerate(values):
                self.coils[addr+i] = bool(v)

    def get_discrete_inputs(self, addr, count):
        with self.lock:
            return self.discrete_inputs[addr:addr+count]

    def get_holding_registers(self, addr, count):
        with self.lock:
            return self.holding_registers[addr:addr+count]

    def set_holding_registers(self, addr, values):
        with self.lock:
            for i, v in enumerate(values):
                self.holding_registers[addr+i] = v & 0xFFFF

    def get_input_registers(self, addr, count):
        with self.lock:
            return self.input_registers[addr:addr+count]


# ========== Modbus TCP Handler ==========
class ModbusTCPHandler:
    def __init__(self, datastore, log_callback, update_callback):
        self.ds = datastore
        self.log = log_callback
        self.update_ui = update_callback

    def handle_request(self, data):
        if len(data) < 8:
            return None
        
        # MBAP Header
        transaction_id = struct.unpack('>H', data[0:2])[0]
        protocol_id    = struct.unpack('>H', data[2:4])[0]
        unit_id        = data[6]
        function_code  = data[7]

        try:
            if function_code == 0x01:   # Read Coils
                return self._fc01(data, transaction_id, unit_id)
            elif function_code == 0x02: # Read Discrete Inputs
                return self._fc02(data, transaction_id, unit_id)
            elif function_code == 0x03: # Read Holding Registers
                return self._fc03(data, transaction_id, unit_id)
            elif function_code == 0x04: # Read Input Registers
                return self._fc04(data, transaction_id, unit_id)
            elif function_code == 0x05: # Write Single Coil
                return self._fc05(data, transaction_id, unit_id)
            elif function_code == 0x06: # Write Single Register
                return self._fc06(data, transaction_id, unit_id)
            elif function_code == 0x0F: # Write Multiple Coils
                return self._fc0F(data, transaction_id, unit_id)
            elif function_code == 0x10: # Write Multiple Registers
                return self._fc10(data, transaction_id, unit_id)
            else:
                return self._error_response(transaction_id, unit_id, function_code, 0x01)
        except Exception as e:
            self.log(f"[ERROR] FC={function_code:#04x}: {e}")
            return self._error_response(transaction_id, unit_id, function_code, 0x04)

    def _mbap(self, transaction_id, unit_id, pdu):
        length = len(pdu) + 1  # unit_id + pdu
        return struct.pack('>HHH', transaction_id, 0, length) + bytes([unit_id]) + pdu

    def _error_response(self, tid, uid, fc, ec):
        pdu = bytes([fc | 0x80, ec])
        return self._mbap(tid, uid, pdu)

    def _fc01(self, data, tid, uid):
        addr  = struct.unpack('>H', data[8:10])[0]
        count = struct.unpack('>H', data[10:12])[0]
        coils = self.ds.get_coils(addr, count)
        byte_count = (count + 7) // 8
        coil_bytes = bytearray(byte_count)
        for i, c in enumerate(coils):
            if c:
                coil_bytes[i // 8] |= (1 << (i % 8))
        pdu = bytes([0x01, byte_count]) + bytes(coil_bytes)
        self.log(f"[FC01] Read Coils addr={addr} count={count} → {list(coils[:count])}")
        return self._mbap(tid, uid, pdu)

    def _fc02(self, data, tid, uid):
        addr  = struct.unpack('>H', data[8:10])[0]
        count = struct.unpack('>H', data[10:12])[0]
        di = self.ds.get_discrete_inputs(addr, count)
        byte_count = (count + 7) // 8
        di_bytes = bytearray(byte_count)
        for i, c in enumerate(di):
            if c:
                di_bytes[i // 8] |= (1 << (i % 8))
        pdu = bytes([0x02, byte_count]) + bytes(di_bytes)
        self.log(f"[FC02] Read DI addr={addr} count={count} → {list(di[:count])}")
        return self._mbap(tid, uid, pdu)

    def _fc03(self, data, tid, uid):
        addr  = struct.unpack('>H', data[8:10])[0]
        count = struct.unpack('>H', data[10:12])[0]
        regs  = self.ds.get_holding_registers(addr, count)
        byte_count = count * 2
        pdu = bytes([0x03, byte_count])
        for r in regs:
            pdu += struct.pack('>H', r)
        self.log(f"[FC03] Read HR addr={addr} count={count} → {regs}")
        return self._mbap(tid, uid, pdu)

    def _fc04(self, data, tid, uid):
        addr  = struct.unpack('>H', data[8:10])[0]
        count = struct.unpack('>H', data[10:12])[0]
        regs  = self.ds.get_input_registers(addr, count)
        byte_count = count * 2
        pdu = bytes([0x04, byte_count])
        for r in regs:
            pdu += struct.pack('>H', r)
        self.log(f"[FC04] Read IR addr={addr} count={count} → {regs}")
        return self._mbap(tid, uid, pdu)

    def _fc05(self, data, tid, uid):
        addr  = struct.unpack('>H', data[8:10])[0]
        value = struct.unpack('>H', data[10:12])[0]
        coil_val = (value == 0xFF00)
        self.ds.set_coils(addr, [coil_val])
        self.log(f"[FC05] Write Coil addr={addr} → {coil_val}")
        self.update_ui()
        pdu = bytes([0x05]) + data[8:12]
        return self._mbap(tid, uid, pdu)

    def _fc06(self, data, tid, uid):
        addr  = struct.unpack('>H', data[8:10])[0]
        value = struct.unpack('>H', data[10:12])[0]
        self.ds.set_holding_registers(addr, [value])
        self.log(f"[FC06] Write HR addr={addr} → {value}")
        self.update_ui()
        pdu = bytes([0x06]) + data[8:12]
        return self._mbap(tid, uid, pdu)

    def _fc0F(self, data, tid, uid):
        addr       = struct.unpack('>H', data[8:10])[0]
        count      = struct.unpack('>H', data[10:12])[0]
        byte_count = data[12]
        coil_bytes = data[13:13+byte_count]
        values = []
        for i in range(count):
            bit = (coil_bytes[i // 8] >> (i % 8)) & 1
            values.append(bool(bit))
        self.ds.set_coils(addr, values)
        self.log(f"[FC0F] Write Coils addr={addr} count={count} → {values}")
        self.update_ui()
        pdu = bytes([0x0F]) + data[8:12]
        return self._mbap(tid, uid, pdu)

    def _fc10(self, data, tid, uid):
        addr       = struct.unpack('>H', data[8:10])[0]
        count      = struct.unpack('>H', data[10:12])[0]
        byte_count = data[12]
        values = []
        for i in range(count):
            v = struct.unpack('>H', data[13+i*2:15+i*2])[0]
            values.append(v)
        self.ds.set_holding_registers(addr, values)
        self.log(f"[FC10] Write HR addr={addr} count={count} → {values}")
        self.update_ui()
        pdu = bytes([0x10]) + data[8:12]
        return self._mbap(tid, uid, pdu)


# ========== Server App ==========
class ModbusServerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("🖥️  MT3A Modbus TCP Server (Slave)")
        self.root.geometry("900x700")
        self.root.configure(bg="#1e1e2e")

        self.ds = ModbusDataStore()
        self.server_thread = None
        self.running = False
        self.client_count = 0

        # Demo: ตั้งค่า input registers จำลอง analog/temperature
        for i in range(8):
            self.ds.input_registers[i] = 5000 + i * 100  # analog ~5.0V
        for i in range(8):
            self.ds.input_registers[8+i] = 2500 + i * 10  # temp ~25.00°C

        self.build_ui()

    def build_ui(self):
        style = ttk.Style()
        style.theme_use('clam')
        style.configure('TLabel', background='#1e1e2e', foreground='#cdd6f4')
        style.configure('TFrame', background='#1e1e2e')
        style.configure('TLabelframe', background='#1e1e2e', foreground='#89b4fa')
        style.configure('TLabelframe.Label', background='#1e1e2e', foreground='#89b4fa', font=('Arial', 10, 'bold'))
        style.configure('TButton', background='#313244', foreground='#cdd6f4')
        style.configure('TEntry', fieldbackground='#313244', foreground='#cdd6f4')
        style.configure('Green.TButton', background='#a6e3a1', foreground='#1e1e2e')
        style.configure('Red.TButton', background='#f38ba8', foreground='#1e1e2e')

        # ---- Top Control Frame ----
        ctrl = ttk.LabelFrame(self.root, text=" ⚙️  Server Control ", padding=10)
        ctrl.pack(fill=tk.X, padx=10, pady=5)

        ttk.Label(ctrl, text="IP:").grid(row=0, column=0, padx=5)
        self.ip_var = tk.StringVar(value="0.0.0.0")
        ttk.Entry(ctrl, textvariable=self.ip_var, width=15).grid(row=0, column=1, padx=5)

        ttk.Label(ctrl, text="Port:").grid(row=0, column=2, padx=5)
        self.port_var = tk.StringVar(value="502")
        ttk.Entry(ctrl, textvariable=self.port_var, width=8).grid(row=0, column=3, padx=5)

        ttk.Label(ctrl, text="Unit ID:").grid(row=0, column=4, padx=5)
        self.uid_var = tk.StringVar(value="1")
        ttk.Entry(ctrl, textvariable=self.uid_var, width=5).grid(row=0, column=5, padx=5)

        self.start_btn = tk.Button(ctrl, text="▶ Start Server",
                                   bg="#a6e3a1", fg="#1e1e2e", font=('Arial',10,'bold'),
                                   command=self.start_server)
        self.start_btn.grid(row=0, column=6, padx=10)

        self.stop_btn = tk.Button(ctrl, text="■ Stop",
                                  bg="#f38ba8", fg="#1e1e2e", font=('Arial',10,'bold'),
                                  command=self.stop_server, state=tk.DISABLED)
        self.stop_btn.grid(row=0, column=7, padx=5)

        self.status_lbl = tk.Label(ctrl, text="● STOPPED", fg="#f38ba8",
                                   bg="#1e1e2e", font=('Arial',10,'bold'))
        self.status_lbl.grid(row=0, column=8, padx=10)

        # ---- Data Frame (Notebook) ----
        nb = ttk.Notebook(self.root)
        nb.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

        # Tab 1: Coils (DO) - 16 channels
        coil_frame = ttk.Frame(nb)
        nb.add(coil_frame, text="  🔴 Coils (DO) FC01/05/0F  ")
        self.build_coils_tab(coil_frame)

        # Tab 2: Discrete Inputs (DI)
        di_frame = ttk.Frame(nb)
        nb.add(di_frame, text="  🟢 Discrete Input (DI) FC02  ")
        self.build_di_tab(di_frame)

        # Tab 3: Input Registers (Analog/Temp)
        ir_frame = ttk.Frame(nb)
        nb.add(ir_frame, text="  📊 Input Registers FC04  ")
        self.build_ir_tab(ir_frame)

        # Tab 4: Holding Registers
        hr_frame = ttk.Frame(nb)
        nb.add(hr_frame, text="  📝 Holding Registers FC03/06/10  ")
        self.build_hr_tab(hr_frame)

        # ---- Log Frame ----
        log_frame = ttk.LabelFrame(self.root, text=" 📋 Communication Log ", padding=5)
        log_frame.pack(fill=tk.BOTH, expand=False, padx=10, pady=5)

        self.log_text = scrolledtext.ScrolledText(
            log_frame, height=8, bg="#181825", fg="#a6e3a1",
            font=('Consolas', 9), insertbackground='white')
        self.log_text.pack(fill=tk.BOTH, expand=True)

        btn_f = tk.Frame(log_frame, bg="#1e1e2e")
        btn_f.pack(fill=tk.X)
        tk.Button(btn_f, text="Clear Log", bg="#313244", fg="#cdd6f4",
                  command=lambda: self.log_text.delete(1.0, tk.END)).pack(side=tk.RIGHT, padx=5)

    def build_coils_tab(self, parent):
        parent.configure(style='TFrame')
        ttk.Label(parent, text="คลิกปุ่มเพื่อ Toggle Coil (จำลอง Digital Output)", 
                  font=('Arial',9)).pack(pady=5)
        
        frame = tk.Frame(parent, bg="#1e1e2e")
        frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

        self.coil_buttons = []
        self.coil_vars = []
        cols = 8
        for i in range(16):
            row, col = divmod(i, cols)
            f = tk.Frame(frame, bg="#1e1e2e", bd=1, relief=tk.GROOVE)
            f.grid(row=row, column=col, padx=5, pady=5, sticky='nsew')
            
            tk.Label(f, text=f"DO {i:02d}", bg="#1e1e2e", fg="#89b4fa",
                     font=('Arial',8,'bold')).pack()
            
            var = tk.BooleanVar(value=False)
            self.coil_vars.append(var)
            
            btn = tk.Button(f, text="OFF", width=6, bg="#45475a", fg="#cdd6f4",
                           command=lambda idx=i: self.toggle_coil(idx))
            btn.pack(pady=2)
            self.coil_buttons.append(btn)

    def build_di_tab(self, parent):
        ttk.Label(parent, text="Discrete Input (DI) - จำลอง Digital Input จาก sensor",
                  font=('Arial',9)).pack(pady=5)
        
        frame = tk.Frame(parent, bg="#1e1e2e")
        frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

        self.di_buttons = []
        self.di_vars = []
        cols = 8
        for i in range(16):
            row, col = divmod(i, cols)
            f = tk.Frame(frame, bg="#1e1e2e", bd=1, relief=tk.GROOVE)
            f.grid(row=row, column=col, padx=5, pady=5, sticky='nsew')
            
            tk.Label(f, text=f"DI {i:02d}", bg="#1e1e2e", fg="#a6e3a1",
                     font=('Arial',8,'bold')).pack()
            
            var = tk.BooleanVar(value=False)
            self.di_vars.append(var)
            self.ds.discrete_inputs[i] = False
            
            btn = tk.Button(f, text="LOW", width=6, bg="#45475a", fg="#cdd6f4",
                           command=lambda idx=i: self.toggle_di(idx))
            btn.pack(pady=2)
            self.di_buttons.append(btn)

    def build_ir_tab(self, parent):
        ttk.Label(parent, text="Input Registers (Read-Only) - Analog/Temp/Weight",
                  font=('Arial',9)).pack(pady=5)
        
        scroll_frame = tk.Frame(parent, bg="#1e1e2e")
        scroll_frame.pack(fill=tk.BOTH, expand=True, padx=10)

        headers = ["Address", "Type", "Raw Value", "Actual Value", "Set Value"]
        for col, h in enumerate(headers):
            tk.Label(scroll_frame, text=h, bg="#313244", fg="#89b4fa",
                     font=('Arial',9,'bold'), width=12, relief=tk.GROOVE).grid(
                         row=0, column=col, padx=1, pady=1)

        self.ir_vars = []
        ir_info = [
            (0, "Analog 0~10V"), (1, "Analog 0~10V"), (2, "Analog 0~10V"), (3, "Analog 0~10V"),
            (4, "Analog 0~20mA"), (5, "Analog 0~20mA"), (6, "Analog 0~20mA"), (7, "Analog 0~20mA"),
            (8, "Temp PT100"), (9, "Temp PT100"), (10, "Temp PT100"), (11, "Temp PT100"),
            (12, "Temp TC-K"), (13, "Temp TC-K"), (14, "Temp TC-K"), (15, "Temp TC-K"),
        ]
        for row, (addr, typ) in enumerate(ir_info, 1):
            tk.Label(scroll_frame, text=f"3{addr+1:04d} / 0x{addr:04X}",
                     bg="#1e1e2e", fg="#cdd6f4", width=14).grid(row=row, column=0, padx=1, pady=1)
            tk.Label(scroll_frame, text=typ,
                     bg="#1e1e2e", fg="#fab387", width=12).grid(row=row, column=1, padx=1, pady=1)
            
            raw_var = tk.StringVar(value=str(self.ds.input_registers[addr]))
            tk.Label(scroll_frame, textvariable=raw_var, bg="#1e1e2e",
                     fg="#f9e2af", width=10).grid(row=row, column=2, padx=1, pady=1)
            
            actual_var = tk.StringVar()
            tk.Label(scroll_frame, textvariable=actual_var, bg="#1e1e2e",
                     fg="#a6e3a1", width=12).grid(row=row, column=3, padx=1, pady=1)

            set_entry = tk.Entry(scroll_frame, bg="#313244", fg="#cdd6f4", width=10)
            set_entry.insert(0, str(self.ds.input_registers[addr]))
            set_entry.grid(row=row, column=4, padx=2, pady=1)

            tk.Button(scroll_frame, text="Set", bg="#313244", fg="#cdd6f4",
                      command=lambda a=addr, e=set_entry: self.set_ir(a, e)).grid(
                          row=row, column=5, padx=2)

            self.ir_vars.append((addr, typ, raw_var, actual_var))

        self.update_ir_display()

    def build_hr_tab(self, parent):
        ttk.Label(parent, text="Holding Registers - อ่าน/เขียนได้ (Analog Output / Config)",
                  font=('Arial',9)).pack(pady=5)
        
        frame = tk.Frame(parent, bg="#1e1e2e")
        frame.pack(fill=tk.BOTH, expand=True, padx=10)

        headers = ["Address", "Hex", "Dec", "Set Value"]
        for col, h in enumerate(headers):
            tk.Label(frame, text=h, bg="#313244", fg="#89b4fa",
                     font=('Arial',9,'bold'), width=12, relief=tk.GROOVE).grid(
                         row=0, column=col, padx=1, pady=1)

        self.hr_vars = []
        for i in range(16):
            tk.Label(frame, text=f"4{i+1:04d} / 0x{i:04X}",
                     bg="#1e1e2e", fg="#cdd6f4", width=14).grid(row=i+1, column=0, padx=1, pady=1)
            
            hex_var = tk.StringVar(value=f"0x{self.ds.holding_registers[i]:04X}")
            dec_var = tk.StringVar(value=str(self.ds.holding_registers[i]))
            
            tk.Label(frame, textvariable=hex_var, bg="#1e1e2e",
                     fg="#f38ba8", width=8).grid(row=i+1, column=1, padx=1)
            tk.Label(frame, textvariable=dec_var, bg="#1e1e2e",
                     fg="#f9e2af", width=8).grid(row=i+1, column=2, padx=1)

            entry = tk.Entry(frame, bg="#313244", fg="#cdd6f4", width=10)
            entry.insert(0, "0")
            entry.grid(row=i+1, column=3, padx=2)

            tk.Button(frame, text="Set", bg="#313244", fg="#cdd6f4",
                      command=lambda idx=i, e=entry: self.set_hr(idx, e)).grid(
                          row=i+1, column=4, padx=2)

            self.hr_vars.append((hex_var, dec_var))

    # ---- Actions ----
    def toggle_coil(self, idx):
        current = self.ds.coils[idx]
        self.ds.set_coils(idx, [not current])
        self.refresh_coil_ui()

    def toggle_di(self, idx):
        current = self.ds.discrete_inputs[idx]
        self.ds.discrete_inputs[idx] = not current
        self.refresh_di_ui()

    def set_ir(self, addr, entry):
        try:
            val = int(entry.get()) & 0xFFFF
            self.ds.input_registers[addr] = val
            self.update_ir_display()
            self.log_msg(f"[UI] Set IR[{addr}] = {val}")
        except ValueError:
            pass

    def set_hr(self, idx, entry):
        try:
            val = int(entry.get()) & 0xFFFF
            self.ds.set_holding_registers(idx, [val])
            self.refresh_hr_ui()
            self.log_msg(f"[UI] Set HR[{idx}] = {val}")
        except ValueError:
            pass

    def refresh_coil_ui(self):
        for i, btn in enumerate(self.coil_buttons):
            val = self.ds.coils[i]
            btn.config(text="ON " if val else "OFF",
                       bg="#a6e3a1" if val else "#45475a",
                       fg="#1e1e2e" if val else "#cdd6f4")

    def refresh_di_ui(self):
        for i, btn in enumerate(self.di_buttons):
            val = self.ds.discrete_inputs[i]
            btn.config(text="HIGH" if val else "LOW",
                       bg="#89dceb" if val else "#45475a",
                       fg="#1e1e2e" if val else "#cdd6f4")

    def refresh_hr_ui(self):
        for i, (hv, dv) in enumerate(self.hr_vars):
            v = self.ds.holding_registers[i]
            hv.set(f"0x{v:04X}")
            dv.set(str(v))

    def update_ir_display(self):
        for addr, typ, raw_var, actual_var in self.ir_vars:
            v = self.ds.input_registers[addr]
            raw_var.set(str(v))
            if "Analog 0~10V" in typ:
                actual_var.set(f"{v/1000:.3f} V")
            elif "0~20mA" in typ:
                actual_var.set(f"{v/1000:.3f} mA")
            elif "PT100" in typ:
                actual_var.set(f"{v/100:.2f} °C")
            elif "TC-K" in typ:
                actual_var.set(f"{v/10:.1f} °C")

    def update_all_ui(self):
        self.root.after(0, self.refresh_coil_ui)
        self.root.after(0, self.refresh_di_ui)
        self.root.after(0, self.refresh_hr_ui)
        self.root.after(0, self.update_ir_display)

    def log_msg(self, msg):
        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        line = f"[{ts}] {msg}\n"
        self.root.after(0, lambda: (
            self.log_text.insert(tk.END, line),
            self.log_text.see(tk.END)
        ))

    # ---- Server Thread ----
    def start_server(self):
        self.running = True
        port = int(self.port_var.get())
        self.server_thread = threading.Thread(
            target=self._server_loop, args=(port,), daemon=True)
        self.server_thread.start()
        self.start_btn.config(state=tk.DISABLED)
        self.stop_btn.config(state=tk.NORMAL)
        self.status_lbl.config(text="● RUNNING", fg="#a6e3a1")
        self.log_msg(f"[SERVER] Started on port {port}")

    def stop_server(self):
        self.running = False
        self.start_btn.config(state=tk.NORMAL)
        self.stop_btn.config(state=tk.DISABLED)
        self.status_lbl.config(text="● STOPPED", fg="#f38ba8")
        self.log_msg("[SERVER] Stopped")

    def _server_loop(self, port):
        handler = ModbusTCPHandler(self.ds, self.log_msg, self.update_all_ui)
        try:
            server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server_sock.bind(('0.0.0.0', port))
            server_sock.listen(5)
            server_sock.settimeout(1.0)
            self.log_msg(f"[SERVER] Listening on 0.0.0.0:{port}")
            while self.running:
                try:
                    conn, addr = server_sock.accept()
                    self.log_msg(f"[CONNECT] Client {addr[0]}:{addr[1]}")
                    t = threading.Thread(
                        target=self._client_handler,
                        args=(conn, addr, handler), daemon=True)
                    t.start()
                except socket.timeout:
                    continue
        except Exception as e:
            self.log_msg(f"[SERVER ERROR] {e}")
        finally:
            server_sock.close()

    def _client_handler(self, conn, addr, handler):
        try:
            conn.settimeout(30)
            while self.running:
                data = conn.recv(1024)
                if not data:
                    break
                self.log_msg(f"[RX] {data.hex().upper()}")
                response = handler.handle_request(data)
                if response:
                    conn.sendall(response)
                    self.log_msg(f"[TX] {response.hex().upper()}")
        except Exception as e:
            pass
        finally:
            conn.close()
            self.log_msg(f"[DISCONNECT] {addr[0]}:{addr[1]}")


if __name__ == "__main__":
    root = tk.Tk()
    app = ModbusServerApp(root)
    root.mainloop()