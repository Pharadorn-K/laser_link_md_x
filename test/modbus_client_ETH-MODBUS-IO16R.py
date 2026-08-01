# Modbus TCP Master (Client) - tailored for AMSAMOTION ETH-MODBUS-IO16R
#
# Device: 16-channel opto-isolated digital input / 16-channel relay digital output module
# Register map (per ETH-MODBUS-IO16R manual v1.0):
#   Coils            0x00-0x0F  -> DO1-DO16 relay outputs   (FC01 read / FC05 write single / FC0F write multiple)
#   Discrete Inputs  0x00-0x0F  -> DI1-DI16 opto inputs      (FC02 read only)
#   Holding Regs     0x00-0x07  -> reserved system config words (FC03 read; FC06/FC10 write - power-cycle to apply)
#   Input Regs       n/a on this module - FC04 only relevant when this module gateways to an RS485 slave device
# Default IP: 192.168.1.12, Port: 502 (TCP client/direct control). Ports 9502/9503 (RTU passthrough) and
# 5502 (multi-slave gateway) are not used for direct I/O control of this module.
import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox
import threading
import socket
import struct
from datetime import datetime

class ModbusTCPClient:
    def __init__(self):
        self.sock = None
        self.transaction_id = 0
        self.lock = threading.Lock()
        self.connected = False

    def connect(self, ip, port, timeout=3):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.settimeout(timeout)
        self.sock.connect((ip, port))
        self.connected = True

    def disconnect(self):
        if self.sock:
            self.sock.close()
            self.sock = None
        self.connected = False

    def _next_tid(self):
        self.transaction_id = (self.transaction_id + 1) % 65536
        return self.transaction_id

    def _send_recv(self, pdu, unit_id):
        tid = self._next_tid()
        mbap = struct.pack('>HHH', tid, 0, len(pdu)+1) + bytes([unit_id]) + pdu
        with self.lock:
            self.sock.sendall(mbap)
            resp = self.sock.recv(1024)
        return mbap, resp

    def read_coils(self, addr, count, uid=1):
        pdu = bytes([0x01]) + struct.pack('>HH', addr, count)
        req, resp = self._send_recv(pdu, uid)
        fc = resp[7]
        if fc == 0x01:
            byte_count = resp[8]
            coil_bytes = resp[9:9+byte_count]
            result = []
            for i in range(count):
                result.append(bool((coil_bytes[i//8] >> (i%8)) & 1))
            return req, resp, result
        raise Exception(f"Error FC {resp[8]:#04x}")

    def read_discrete_inputs(self, addr, count, uid=1):
        pdu = bytes([0x02]) + struct.pack('>HH', addr, count)
        req, resp = self._send_recv(pdu, uid)
        fc = resp[7]
        if fc == 0x02:
            byte_count = resp[8]
            di_bytes = resp[9:9+byte_count]
            result = []
            for i in range(count):
                result.append(bool((di_bytes[i//8] >> (i%8)) & 1))
            return req, resp, result
        raise Exception(f"Error FC {resp[8]:#04x}")

    def read_holding_registers(self, addr, count, uid=1):
        pdu = bytes([0x03]) + struct.pack('>HH', addr, count)
        req, resp = self._send_recv(pdu, uid)
        if resp[7] == 0x03:
            byte_count = resp[8]
            vals = [struct.unpack('>H', resp[9+i*2:11+i*2])[0] for i in range(count)]
            return req, resp, vals
        raise Exception(f"Error FC {resp[8]:#04x}")

    def read_input_registers(self, addr, count, uid=1):
        pdu = bytes([0x04]) + struct.pack('>HH', addr, count)
        req, resp = self._send_recv(pdu, uid)
        if resp[7] == 0x04:
            byte_count = resp[8]
            vals = [struct.unpack('>H', resp[9+i*2:11+i*2])[0] for i in range(count)]
            return req, resp, vals
        raise Exception(f"Error FC {resp[8]:#04x}")

    def write_single_coil(self, addr, value, uid=1):
        val_word = 0xFF00 if value else 0x0000
        pdu = bytes([0x05]) + struct.pack('>HH', addr, val_word)
        req, resp = self._send_recv(pdu, uid)
        return req, resp

    def write_single_register(self, addr, value, uid=1):
        pdu = bytes([0x06]) + struct.pack('>HH', addr, value)
        req, resp = self._send_recv(pdu, uid)
        return req, resp

    def write_multiple_coils(self, addr, values, uid=1):
        count = len(values)
        byte_count = (count + 7) // 8
        coil_bytes = bytearray(byte_count)
        for i, v in enumerate(values):
            if v:
                coil_bytes[i//8] |= (1 << (i%8))
        pdu = bytes([0x0F]) + struct.pack('>HH', addr, count) + bytes([byte_count]) + bytes(coil_bytes)
        req, resp = self._send_recv(pdu, uid)
        return req, resp

    def write_multiple_registers(self, addr, values, uid=1):
        count = len(values)
        byte_count = count * 2
        pdu = bytes([0x10]) + struct.pack('>HH', addr, count) + bytes([byte_count])
        for v in values:
            pdu += struct.pack('>H', v & 0xFFFF)
        req, resp = self._send_recv(pdu, uid)
        return req, resp


# ========== Client App ==========
class ModbusClientApp:
    def __init__(self, root):
        self.root = root
        self.root.title("🎮  Modbus TCP Master — ETH-MODBUS-IO16R (16DI/16DO)")
        self.root.geometry("950x750")
        self.root.configure(bg="#1e1e2e")

        self.client = ModbusTCPClient()
        self.auto_poll = False
        self.poll_thread = None
        self.build_ui()

    def build_ui(self):
        style = ttk.Style()
        style.theme_use('clam')
        style.configure('TFrame', background='#1e1e2e')
        style.configure('TLabel', background='#1e1e2e', foreground='#cdd6f4')
        style.configure('TLabelframe', background='#1e1e2e', foreground='#89b4fa')
        style.configure('TLabelframe.Label', background='#1e1e2e', foreground='#89b4fa',
                        font=('Arial', 10, 'bold'))
        style.configure('TNotebook', background='#1e1e2e')
        style.configure('TNotebook.Tab', background='#313244', foreground='#cdd6f4')

        # ---- Connection Frame ----
        conn = ttk.LabelFrame(self.root, text=" 🔌 Connection ", padding=10)
        conn.pack(fill=tk.X, padx=10, pady=5)

        fields = [("IP:", "192.168.1.12", 15), ("Port:", "502", 6), ("Unit ID:", "1", 5)]
        self.ip_var   = tk.StringVar(value="192.168.1.12")
        self.port_var = tk.StringVar(value="502")
        self.uid_var  = tk.StringVar(value="1")
        vars_list = [self.ip_var, self.port_var, self.uid_var]

        for col, ((lbl, default, w), var) in enumerate(zip(fields, vars_list)):
            tk.Label(conn, text=lbl, bg="#1e1e2e", fg="#cdd6f4").grid(row=0, column=col*2, padx=3)
            e = tk.Entry(conn, textvariable=var, width=w, bg="#313244", fg="#cdd6f4")
            e.grid(row=0, column=col*2+1, padx=3)

        self.conn_btn = tk.Button(conn, text="🔗 Connect",
                                  bg="#a6e3a1", fg="#1e1e2e", font=('Arial',10,'bold'),
                                  command=self.connect)
        self.conn_btn.grid(row=0, column=6, padx=10)

        self.disc_btn = tk.Button(conn, text="✂ Disconnect",
                                  bg="#f38ba8", fg="#1e1e2e", font=('Arial',10,'bold'),
                                  command=self.disconnect, state=tk.DISABLED)
        self.disc_btn.grid(row=0, column=7, padx=5)

        self.conn_status = tk.Label(conn, text="● DISCONNECTED",
                                    fg="#f38ba8", bg="#1e1e2e", font=('Arial',10,'bold'))
        self.conn_status.grid(row=0, column=8, padx=10)

        # ---- Notebook ----
        nb = ttk.Notebook(self.root)
        nb.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

        # Tab 1: Quick Command
        quick = ttk.Frame(nb)
        nb.add(quick, text="  ⚡ Quick Command  ")
        self.build_quick_tab(quick)

        # Tab 2: Read Data
        read = ttk.Frame(nb)
        nb.add(read, text="  📥 Read Data  ")
        self.build_read_tab(read)

        # Tab 3: Write Data
        write = ttk.Frame(nb)
        nb.add(write, text="  📤 Write Data  ")
        self.build_write_tab(write)

        # Tab 4: Auto Poll (Monitor)
        monitor = ttk.Frame(nb)
        nb.add(monitor, text="  🔄 Auto Monitor  ")
        self.build_monitor_tab(monitor)

        # ---- Log ----
        log_f = ttk.LabelFrame(self.root, text=" 📋 Raw Communication Log ", padding=5)
        log_f.pack(fill=tk.BOTH, expand=False, padx=10, pady=5)

        self.log_text = scrolledtext.ScrolledText(
            log_f, height=7, bg="#181825", fg="#a6e3a1",
            font=('Consolas', 9), insertbackground='white')
        self.log_text.pack(fill=tk.BOTH, expand=True)

        tk.Button(log_f, text="Clear", bg="#313244", fg="#cdd6f4",
                  command=lambda: self.log_text.delete(1.0, tk.END)).pack(side=tk.RIGHT)

    def build_quick_tab(self, parent):
        # ---- Write Single Coil ----
        fc05 = ttk.LabelFrame(parent, text=" FC05 - Write Single Coil ", padding=10)
        fc05.pack(fill=tk.X, padx=10, pady=5)

        tk.Label(fc05, text="Addr:", bg="#1e1e2e", fg="#cdd6f4").grid(row=0, column=0, padx=5)
        self.fc05_addr = tk.Entry(fc05, width=6, bg="#313244", fg="#cdd6f4")
        self.fc05_addr.insert(0, "0")
        self.fc05_addr.grid(row=0, column=1, padx=5)

        tk.Button(fc05, text="Write ON",  bg="#a6e3a1", fg="#1e1e2e",
                  command=lambda: self.exec_write_coil(True)).grid(row=0, column=2, padx=5)
        tk.Button(fc05, text="Write OFF", bg="#f38ba8", fg="#1e1e2e",
                  command=lambda: self.exec_write_coil(False)).grid(row=0, column=3, padx=5)

        # Toggle all
        tk.Label(fc05, text="   Toggle All Coils (0-15):", bg="#1e1e2e", fg="#cdd6f4").grid(
            row=0, column=4, padx=10)
        tk.Button(fc05, text="ALL ON",  bg="#a6e3a1", fg="#1e1e2e",
                  command=lambda: self.exec_write_multiple_coils([True]*16, 0)).grid(row=0, column=5, padx=3)
        tk.Button(fc05, text="ALL OFF", bg="#45475a", fg="#cdd6f4",
                  command=lambda: self.exec_write_multiple_coils([False]*16, 0)).grid(row=0, column=6, padx=3)

        # ---- Write Single Register ----
        fc06 = ttk.LabelFrame(parent, text=" FC06 - Write Single Register ", padding=10)
        fc06.pack(fill=tk.X, padx=10, pady=5)

        tk.Label(fc06, text="Addr:", bg="#1e1e2e", fg="#cdd6f4").grid(row=0, column=0, padx=5)
        self.fc06_addr = tk.Entry(fc06, width=6, bg="#313244", fg="#cdd6f4")
        self.fc06_addr.insert(0, "0")
        self.fc06_addr.grid(row=0, column=1, padx=5)

        tk.Label(fc06, text="Value:", bg="#1e1e2e", fg="#cdd6f4").grid(row=0, column=2, padx=5)
        self.fc06_val = tk.Entry(fc06, width=8, bg="#313244", fg="#cdd6f4")
        self.fc06_val.insert(0, "0")
        self.fc06_val.grid(row=0, column=3, padx=5)

        tk.Button(fc06, text="Write Register", bg="#89b4fa", fg="#1e1e2e",
                  command=self.exec_write_register).grid(row=0, column=4, padx=10)

        tk.Label(fc06, text="   (Registers 0x00-0x07 are reserved system config words on\n"
                             "   this module - FC06/FC10 only address local slaves when this\n"
                             "   module is used as a MODBUS TCP-to-RTU gateway)",
                 bg="#1e1e2e", fg="#6c7086", justify=tk.LEFT, font=('Arial', 8)).grid(
            row=0, column=5, padx=10, sticky='w')

        # ---- Read Quick ----
        read_q = ttk.LabelFrame(parent, text=" Quick Read ", padding=10)
        read_q.pack(fill=tk.X, padx=10, pady=5)

        btns = [
            ("Read Coils [0-15]", lambda: self.quick_read('coils')),
            ("Read DI [0-15]",    lambda: self.quick_read('di')),
            ("Read HR [reserved cfg]", lambda: self.quick_read('hr')),
        ]
        for col, (txt, cmd) in enumerate(btns):
            tk.Button(read_q, text=txt, bg="#313244", fg="#cdd6f4",
                      command=cmd).grid(row=0, column=col, padx=5)

        self.quick_result = scrolledtext.ScrolledText(
            parent, height=8, bg="#181825", fg="#f9e2af",
            font=('Consolas', 10))
        self.quick_result.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

    def build_read_tab(self, parent):
        frame = ttk.LabelFrame(parent, text=" Read Parameters ", padding=10)
        frame.pack(fill=tk.X, padx=10, pady=5)

        params = [
            ("Function Code:", ["FC01-ReadCoils", "FC02-ReadDI",
                                 "FC03-ReadHR", "FC04-ReadIR"]),
        ]
        tk.Label(frame, text="Function:", bg="#1e1e2e", fg="#cdd6f4").grid(row=0, column=0, padx=5)
        self.read_fc = ttk.Combobox(frame, width=18,
            values=["FC01 - Read Coils", "FC02 - Read Discrete Input",
                    "FC03 - Read Holding Reg", "FC04 - Read Input Reg"])
        self.read_fc.current(3)
        self.read_fc.grid(row=0, column=1, padx=5)

        tk.Label(frame, text="Start Addr:", bg="#1e1e2e", fg="#cdd6f4").grid(row=0, column=2, padx=5)
        self.read_addr = tk.Entry(frame, width=6, bg="#313244", fg="#cdd6f4")
        self.read_addr.insert(0, "0")
        self.read_addr.grid(row=0, column=3, padx=5)

        tk.Label(frame, text="Count:", bg="#1e1e2e", fg="#cdd6f4").grid(row=0, column=4, padx=5)
        self.read_count = tk.Entry(frame, width=6, bg="#313244", fg="#cdd6f4")
        self.read_count.insert(0, "8")
        self.read_count.grid(row=0, column=5, padx=5)

        tk.Button(frame, text="📥 Read", bg="#89b4fa", fg="#1e1e2e",
                  font=('Arial',10,'bold'), command=self.exec_read).grid(row=0, column=6, padx=10)

        # Result Table
        result_f = ttk.LabelFrame(parent, text=" Results ", padding=5)
        result_f.pack(fill=tk.BOTH, expand=True, padx=10, pady=5)

        cols = ("Address", "PLC Addr", "Hex", "Dec", "Value")
        self.read_tree = ttk.Treeview(result_f, columns=cols, show='headings', height=15)
        for col in cols:
            self.read_tree.heading(col, text=col)
            self.read_tree.column(col, width=120, anchor='center')
        
        vsb = ttk.Scrollbar(result_f, orient="vertical", command=self.read_tree.yview)
        self.read_tree.configure(yscrollcommand=vsb.set)
        self.read_tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        vsb.pack(side=tk.RIGHT, fill=tk.Y)

    def build_write_tab(self, parent):
        # FC06 Multiple
        fc10_f = ttk.LabelFrame(parent, text=" FC10 - Write Multiple Registers ", padding=10)
        fc10_f.pack(fill=tk.X, padx=10, pady=5)

        tk.Label(fc10_f, text="Start Addr:", bg="#1e1e2e", fg="#cdd6f4").grid(row=0, column=0)
        self.wm_addr = tk.Entry(fc10_f, width=6, bg="#313244", fg="#cdd6f4")
        self.wm_addr.insert(0, "0")
        self.wm_addr.grid(row=0, column=1, padx=5)

        tk.Label(fc10_f, text="Values (comma):", bg="#1e1e2e", fg="#cdd6f4").grid(row=0, column=2)
        self.wm_vals = tk.Entry(fc10_f, width=30, bg="#313244", fg="#cdd6f4")
        self.wm_vals.insert(0, "100, 200, 300, 400")
        self.wm_vals.grid(row=0, column=3, padx=5)

        tk.Button(fc10_f, text="Write Multiple Regs",
                  bg="#89b4fa", fg="#1e1e2e",
                  command=self.exec_write_multiple_regs).grid(row=0, column=4, padx=10)

        # FC0F Multiple Coils
        fc0f_f = ttk.LabelFrame(parent, text=" FC0F - Write Multiple Coils ", padding=10)
        fc0f_f.pack(fill=tk.X, padx=10, pady=5)

        tk.Label(fc0f_f, text="Start Addr:", bg="#1e1e2e", fg="#cdd6f4").grid(row=0, column=0)
        self.wc_addr = tk.Entry(fc0f_f, width=6, bg="#313244", fg="#cdd6f4")
        self.wc_addr.insert(0, "0")
        self.wc_addr.grid(row=0, column=1, padx=5)

        tk.Label(fc0f_f, text="Coils (0/1 comma):", bg="#1e1e2e", fg="#cdd6f4").grid(row=0, column=2)
        self.wc_vals = tk.Entry(fc0f_f, width=30, bg="#313244", fg="#cdd6f4")
        self.wc_vals.insert(0, "1,0,1,0,1,0,1,0")
        self.wc_vals.grid(row=0, column=3, padx=5)

        tk.Button(fc0f_f, text="Write Multiple Coils",
                  bg="#a6e3a1", fg="#1e1e2e",
                  command=self.exec_write_multiple_coils_ui).grid(row=0, column=4, padx=10)

        # Device note (ETH-MODBUS-IO16R is pure digital I/O, no analog channels)
        note_f = ttk.LabelFrame(parent, text=" ℹ Device Notes (ETH-MODBUS-IO16R) ", padding=10)
        note_f.pack(fill=tk.X, padx=10, pady=5)
        tk.Label(note_f,
                 text="This module is a 16-channel digital input / 16-channel relay output device.\n"
                      "It has no analog I/O. Use the coil controls above (FC05/FC0F) for the 16 relay\n"
                      "outputs, and FC02 reads in the Read tab for the 16 digital inputs.\n"
                      "Default bus mode is 'Bus Error Reset' - if this module stops receiving MODBUS\n"
                      "messages for >2s, it will reset all relay outputs to OFF. Change to 'Bus Error\n"
                      "Hold' via the module's config tool/webpage if that behavior is undesirable.",
                 bg="#1e1e2e", fg="#a6adc8", justify=tk.LEFT, font=('Arial', 9)).pack(anchor='w')

    def build_monitor_tab(self, parent):
        ctrl = tk.Frame(parent, bg="#1e1e2e")
        ctrl.pack(fill=tk.X, padx=10, pady=5)

        tk.Label(ctrl, text="Poll Interval (ms):", bg="#1e1e2e", fg="#cdd6f4").pack(side=tk.LEFT)
        self.poll_ms = tk.Entry(ctrl, width=6, bg="#313244", fg="#cdd6f4")
        self.poll_ms.insert(0, "1000")
        self.poll_ms.pack(side=tk.LEFT, padx=5)

        self.auto_btn = tk.Button(ctrl, text="▶ Start Auto Poll",
                                  bg="#a6e3a1", fg="#1e1e2e", font=('Arial',10,'bold'),
                                  command=self.toggle_auto_poll)
        self.auto_btn.pack(side=tk.LEFT, padx=10)

        # Monitor Display
        mon_frame = tk.Frame(parent, bg="#1e1e2e")
        mon_frame.pack(fill=tk.BOTH, expand=True, padx=10)

        # Coils display
        coil_lf = ttk.LabelFrame(mon_frame, text=" Coils (DO) ", padding=5)
        coil_lf.grid(row=0, column=0, padx=5, pady=5, sticky='nsew')
        self.mon_coil_labels = []
        for i in range(16):
            r, c = divmod(i, 8)
            lbl = tk.Label(coil_lf, text=f"Q{i:02d}\n---",
                           bg="#45475a", fg="#cdd6f4",
                           width=5, relief=tk.RAISED, font=('Arial',7))
            lbl.grid(row=r, column=c, padx=2, pady=2)
            self.mon_coil_labels.append(lbl)

        # DI display
        di_lf = ttk.LabelFrame(mon_frame, text=" Discrete Input (DI) ", padding=5)
        di_lf.grid(row=0, column=1, padx=5, pady=5, sticky='nsew')
        self.mon_di_labels = []
        for i in range(16):
            r, c = divmod(i, 8)
            lbl = tk.Label(di_lf, text=f"I{i:02d}\n---",
                           bg="#45475a", fg="#cdd6f4",
                           width=5, relief=tk.RAISED, font=('Arial',7))
            lbl.grid(row=r, column=c, padx=2, pady=2)
            self.mon_di_labels.append(lbl)

        tk.Label(mon_frame,
                 text="ETH-MODBUS-IO16R has no analog/input registers to poll - only coils (DO) and discrete inputs (DI) above.",
                 bg="#1e1e2e", fg="#6c7086", font=('Arial', 8)).grid(
            row=1, column=0, columnspan=2, pady=5, sticky='w')

    # ========== Actions ==========
    def connect(self):
        try:
            ip   = self.ip_var.get()
            port = int(self.port_var.get())
            self.client.connect(ip, port)
            self.conn_status.config(text="● CONNECTED", fg="#a6e3a1")
            self.conn_btn.config(state=tk.DISABLED)
            self.disc_btn.config(state=tk.NORMAL)
            self.log_msg(f"[CONNECT] {ip}:{port}")
        except Exception as e:
            messagebox.showerror("Connection Error", str(e))
            self.log_msg(f"[ERROR] {e}")

    def disconnect(self):
        self.auto_poll = False
        self.client.disconnect()
        self.conn_status.config(text="● DISCONNECTED", fg="#f38ba8")
        self.conn_btn.config(state=tk.NORMAL)
        self.disc_btn.config(state=tk.DISABLED)
        self.log_msg("[DISCONNECT]")

    def log_msg(self, msg):
        from datetime import datetime
        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        line = f"[{ts}] {msg}\n"
        self.root.after(0, lambda: (
            self.log_text.insert(tk.END, line),
            self.log_text.see(tk.END)
        ))

    def _run_in_thread(self, func):
        threading.Thread(target=func, daemon=True).start()

    def exec_write_coil(self, value):
        def task():
            try:
                addr = int(self.fc05_addr.get())
                uid  = int(self.uid_var.get())
                req, resp = self.client.write_single_coil(addr, value, uid)
                self.log_msg(f"[FC05] Coil[{addr}]={'ON' if value else 'OFF'} | TX:{req.hex().upper()} RX:{resp.hex().upper()}")
            except Exception as e:
                self.log_msg(f"[ERROR] {e}")
        self._run_in_thread(task)

    def exec_write_register(self):
        def task():
            try:
                addr = int(self.fc06_addr.get())
                val  = int(self.fc06_val.get())
                uid  = int(self.uid_var.get())
                req, resp = self.client.write_single_register(addr, val, uid)
                self.log_msg(f"[FC06] HR[{addr}]={val} | TX:{req.hex().upper()} RX:{resp.hex().upper()}")
            except Exception as e:
                self.log_msg(f"[ERROR] {e}")
        self._run_in_thread(task)

    def exec_write_multiple_coils(self, values, addr=None):
        def task():
            try:
                a   = addr if addr is not None else int(self.wc_addr.get())
                uid = int(self.uid_var.get())
                req, resp = self.client.write_multiple_coils(a, values, uid)
                self.log_msg(f"[FC0F] Coils[{a}..{a+len(values)-1}]={values}")
            except Exception as e:
                self.log_msg(f"[ERROR] {e}")
        self._run_in_thread(task)

    def exec_write_multiple_coils_ui(self):
        try:
            vals_str = self.wc_vals.get().split(',')
            values   = [bool(int(v.strip())) for v in vals_str]
            addr     = int(self.wc_addr.get())
            self.exec_write_multiple_coils(values, addr)
        except Exception as e:
            self.log_msg(f"[ERROR] {e}")

    def exec_write_multiple_regs(self):
        def task():
            try:
                addr = int(self.wm_addr.get())
                vals = [int(v.strip()) for v in self.wm_vals.get().split(',')]
                uid  = int(self.uid_var.get())
                req, resp = self.client.write_multiple_registers(addr, vals, uid)
                self.log_msg(f"[FC10] HR[{addr}..{addr+len(vals)-1}]={vals}")
            except Exception as e:
                self.log_msg(f"[ERROR] {e}")
        self._run_in_thread(task)

    def exec_read(self):
        def task():
            try:
                fc_str = self.read_fc.get()
                addr   = int(self.read_addr.get())
                count  = int(self.read_count.get())
                uid    = int(self.uid_var.get())

                if "FC01" in fc_str:
                    req, resp, vals = self.client.read_coils(addr, count, uid)
                    fc_type = "Coil"
                    plc_prefix = "0"
                elif "FC02" in fc_str:
                    req, resp, vals = self.client.read_discrete_inputs(addr, count, uid)
                    fc_type = "DI"
                    plc_prefix = "1"
                elif "FC03" in fc_str:
                    req, resp, vals = self.client.read_holding_registers(addr, count, uid)
                    fc_type = "HR"
                    plc_prefix = "4"
                else:
                    req, resp, vals = self.client.read_input_registers(addr, count, uid)
                    fc_type = "IR"
                    plc_prefix = "3"

                self.log_msg(f"[{fc_type}] addr={addr} count={count} → {vals}")
                self.log_msg(f"  TX:{req.hex().upper()}")
                self.log_msg(f"  RX:{resp.hex().upper()}")

                # Update treeview
                self.root.after(0, lambda: self._update_read_tree(
                    vals, addr, fc_type, plc_prefix))
            except Exception as e:
                self.log_msg(f"[ERROR] {e}")
        self._run_in_thread(task)

    def _update_read_tree(self, vals, start_addr, fc_type, prefix):
        for item in self.read_tree.get_children():
            self.read_tree.delete(item)
        for i, v in enumerate(vals):
            a = start_addr + i
            plc_addr = f"{prefix}{a+1:04d}"
            if isinstance(v, bool):
                hex_str = "0x01" if v else "0x00"
                dec_str = "1" if v else "0"
                val_str = "TRUE" if v else "FALSE"
            else:
                hex_str = f"0x{v:04X}"
                dec_str = str(v)
                val_str = str(v)
            self.read_tree.insert('', tk.END, values=(
                f"0x{a:04X}", plc_addr, hex_str, dec_str, val_str))

    def quick_read(self, mode):
        def task():
            try:
                uid = int(self.uid_var.get())
                result_lines = []
                if mode == 'coils':
                    _, _, vals = self.client.read_coils(0, 16, uid)
                    result_lines.append("=== Coils (FC01) addr=0-15 ===")
                    for i, v in enumerate(vals):
                        result_lines.append(f"  Coil[{i:02d}] = {'ON ' if v else 'OFF'}")
                elif mode == 'di':
                    _, _, vals = self.client.read_discrete_inputs(0, 16, uid)
                    result_lines.append("=== Discrete Input (FC02) addr=0-15 ===")
                    for i, v in enumerate(vals):
                        result_lines.append(f"  DI[{i:02d}] = {'HIGH' if v else 'LOW '}")
                elif mode == 'hr':
                    # Only addresses 0x00-0x07 are populated (reserved system config words);
                    # 0x08-0x0F will read as 0 / may error depending on firmware.
                    _, _, vals = self.client.read_holding_registers(0, 8, uid)
                    result_lines.append("=== Holding Registers (FC03) addr=0x00-0x07 - reserved system config ===")
                    for i, v in enumerate(vals):
                        result_lines.append(f"  HR[{i:02d}] = {v:5d}  (0x{v:04X})")
                    result_lines.append("  (Not general-purpose I/O - see manual sec. 3.6/3.7 for meaning of each word)")

                text = "\n".join(result_lines) + "\n" + "-"*40 + "\n"
                self.root.after(0, lambda: (
                    self.quick_result.delete(1.0, tk.END),
                    self.quick_result.insert(tk.END, text)
                ))
            except Exception as e:
                self.log_msg(f"[ERROR] {e}")
        self._run_in_thread(task)

    def toggle_auto_poll(self):
        if not self.auto_poll:
            if not self.client.connected:
                messagebox.showwarning("Not Connected", "Please connect first!")
                return
            self.auto_poll = True
            self.auto_btn.config(text="■ Stop Auto Poll", bg="#f38ba8")
            self.poll_thread = threading.Thread(target=self._poll_loop, daemon=True)
            self.poll_thread.start()
        else:
            self.auto_poll = False
            self.auto_btn.config(text="▶ Start Auto Poll", bg="#a6e3a1")

    def _poll_loop(self):
        import time
        while self.auto_poll and self.client.connected:
            try:
                uid = int(self.uid_var.get())
                ms  = int(self.poll_ms.get())

                # Read coils (16 relay outputs)
                _, _, coils = self.client.read_coils(0, 16, uid)
                # Read DI (16 opto-isolated inputs)
                _, _, dis   = self.client.read_discrete_inputs(0, 16, uid)

                self.root.after(0, lambda c=coils, d=dis:
                    self._update_monitor(c, d))

                time.sleep(ms / 1000.0)
            except Exception as e:
                self.log_msg(f"[POLL ERROR] {e}")
                self.auto_poll = False
                self.root.after(0, lambda: self.auto_btn.config(
                    text="▶ Start Auto Poll", bg="#a6e3a1"))
                break

    def _update_monitor(self, coils, dis):
        for i, (lbl, v) in enumerate(zip(self.mon_coil_labels, coils)):
            lbl.config(text=f"Q{i:02d}\n{'ON' if v else 'OFF'}",
                       bg="#a6e3a1" if v else "#45475a",
                       fg="#1e1e2e" if v else "#cdd6f4")
        for i, (lbl, v) in enumerate(zip(self.mon_di_labels, dis)):
            lbl.config(text=f"I{i:02d}\n{'HI' if v else 'LO'}",
                       bg="#89dceb" if v else "#45475a",
                       fg="#1e1e2e" if v else "#cdd6f4")


if __name__ == "__main__":
    root = tk.Tk()
    app = ModbusClientApp(root)
    root.mainloop()