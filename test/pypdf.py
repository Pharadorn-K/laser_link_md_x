import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import os
import threading

# ── Library Detection ──────────────────────────────────────────
try:
    import pikepdf
    PIKEPDF_AVAILABLE = True
except ImportError:
    PIKEPDF_AVAILABLE = False

try:
    from PyPDF2 import PdfMerger, PdfReader, PdfWriter
    PYPDF2_AVAILABLE = True
except ImportError:
    PYPDF2_AVAILABLE = False


# ══════════════════════════════════════════════════════════════════
#  TAB 1 ── PDF Merger
# ══════════════════════════════════════════════════════════════════
class MergerTab:
    def __init__(self, parent):
        self.frame = tk.Frame(parent, bg="#2c3e50")
        self.pdf_files = []
        self.build_ui()

    # ── UI ────────────────────────────────────────────────────────
    def build_ui(self):
        # Title
        tk.Label(
            self.frame,
            text="🔗 PDF Merger",
            font=("Helvetica", 20, "bold"),
            fg="#ecf0f1",
            bg="#2c3e50",
        ).pack(pady=(18, 2))

        tk.Label(
            self.frame,
            text="Add PDF files, reorder them, then merge into one file.",
            font=("Helvetica", 9),
            fg="#bdc3c7",
            bg="#2c3e50",
        ).pack(pady=(0, 10))

        # ── File List ──
        list_lf = tk.LabelFrame(
            self.frame,
            text="  PDF Files  ",
            font=("Helvetica", 10, "bold"),
            fg="#ecf0f1",
            bg="#34495e",
            padx=10,
            pady=8,
        )
        list_lf.pack(fill="both", padx=25, pady=4)

        scrollbar = tk.Scrollbar(list_lf)
        scrollbar.pack(side="right", fill="y")

        self.listbox = tk.Listbox(
            list_lf,
            yscrollcommand=scrollbar.set,
            selectmode=tk.SINGLE,
            font=("Helvetica", 9),
            height=9,
            bg="#2c3e50",
            fg="#ecf0f1",
            selectbackground="#3498db",
            selectforeground="white",
            relief="flat",
            bd=0,
            activestyle="none",
        )
        self.listbox.pack(fill="both", expand=True)
        scrollbar.config(command=self.listbox.yview)

        # ── Action Buttons ──
        btn_frame = tk.Frame(self.frame, bg="#2c3e50")
        btn_frame.pack(pady=8)

        buttons = [
            ("➕ Add Files",  "#3498db", self.add_files),
            ("⬆ Move Up",    "#6c757d", self.move_up),
            ("⬇ Move Down",  "#6c757d", self.move_down),
            ("🗑 Remove",    "#e74c3c", self.remove_file),
            ("🧹 Clear All", "#e67e22", self.clear_all),
        ]
        for i, (txt, color, cmd) in enumerate(buttons):
            tk.Button(
                btn_frame,
                text=txt,
                bg=color,
                fg="white",
                font=("Helvetica", 9),
                relief="flat",
                cursor="hand2",
                pady=5,
                width=12,
                command=cmd,
            ).grid(row=0, column=i, padx=4)

        # ── Output File ──
        out_lf = tk.LabelFrame(
            self.frame,
            text="  Output File  ",
            font=("Helvetica", 10, "bold"),
            fg="#ecf0f1",
            bg="#34495e",
            padx=10,
            pady=8,
        )
        out_lf.pack(fill="x", padx=25, pady=4)

        self.output_var = tk.StringVar(value="merged_output.pdf")

        tk.Entry(
            out_lf,
            textvariable=self.output_var,
            font=("Helvetica", 9),
            bg="#2c3e50",
            fg="#ecf0f1",
            insertbackground="white",
            relief="flat",
            bd=4,
        ).pack(side="left", fill="x", expand=True, ipady=4)

        tk.Button(
            out_lf,
            text="📁 Browse",
            bg="#3498db",
            fg="white",
            font=("Helvetica", 9),
            relief="flat",
            cursor="hand2",
            pady=4,
            command=self.browse_output,
        ).pack(side="right", padx=(8, 0))

        # ── Progress ──
        self.progress = ttk.Progressbar(
            self.frame, orient="horizontal", length=520, mode="determinate"
        )
        self.progress.pack(pady=(10, 0))

        # ── Merge Button ──
        self.merge_btn = tk.Button(
            self.frame,
            text="🔗  MERGE PDFs",
            bg="#27ae60",
            fg="white",
            font=("Helvetica", 12, "bold"),
            relief="flat",
            cursor="hand2",
            pady=9,
            width=22,
            command=self.merge_pdfs,
        )
        self.merge_btn.pack(pady=12)

        # ── Status ──
        self.status_var = tk.StringVar(value="Ready – add PDF files to get started.")
        tk.Label(
            self.frame,
            textvariable=self.status_var,
            font=("Helvetica", 8),
            fg="#bdc3c7",
            bg="#2c3e50",
            anchor="w",
        ).pack(fill="x", padx=25)

    # ── Helpers ───────────────────────────────────────────────────
    def add_files(self):
        files = filedialog.askopenfilenames(
            title="Select PDF Files",
            filetypes=[("PDF Files", "*.pdf")],
        )
        for f in files:
            if f not in self.pdf_files:
                self.pdf_files.append(f)
                self.listbox.insert(tk.END, f"  {os.path.basename(f)}")
        self._update_status()

    def remove_file(self):
        sel = self.listbox.curselection()
        if not sel:
            messagebox.showwarning("Warning", "Please select a file to remove.")
            return
        idx = sel[0]
        self.listbox.delete(idx)
        self.pdf_files.pop(idx)
        self._update_status()

    def move_up(self):
        sel = self.listbox.curselection()
        if not sel or sel[0] == 0:
            return
        i = sel[0]
        self.pdf_files[i], self.pdf_files[i - 1] = self.pdf_files[i - 1], self.pdf_files[i]
        item = self.listbox.get(i)
        self.listbox.delete(i)
        self.listbox.insert(i - 1, item)
        self.listbox.select_set(i - 1)

    def move_down(self):
        sel = self.listbox.curselection()
        if not sel or sel[0] == len(self.pdf_files) - 1:
            return
        i = sel[0]
        self.pdf_files[i], self.pdf_files[i + 1] = self.pdf_files[i + 1], self.pdf_files[i]
        item = self.listbox.get(i)
        self.listbox.delete(i)
        self.listbox.insert(i + 1, item)
        self.listbox.select_set(i + 1)

    def clear_all(self):
        if self.pdf_files and messagebox.askyesno("Clear All", "Remove all files from the list?"):
            self.pdf_files.clear()
            self.listbox.delete(0, tk.END)
            self._update_status()

    def browse_output(self):
        path = filedialog.asksaveasfilename(
            title="Save Merged PDF As",
            defaultextension=".pdf",
            filetypes=[("PDF Files", "*.pdf")],
            initialfile="merged_output.pdf",
        )
        if path:
            self.output_var.set(path)

    def merge_pdfs(self):
        if not PYPDF2_AVAILABLE:
            messagebox.showerror("Error", "PyPDF2 is required for merging.\npip install pypdf2")
            return
        if len(self.pdf_files) < 2:
            messagebox.showwarning("Warning", "Please add at least 2 PDF files to merge.")
            return
        output_path = self.output_var.get().strip()
        if not output_path:
            messagebox.showwarning("Warning", "Please specify an output file name.")
            return

        self.merge_btn.config(state=tk.DISABLED)
        self.progress["value"] = 0

        def _run():
            try:
                merger = PdfMerger()
                total = len(self.pdf_files)
                for i, pdf in enumerate(self.pdf_files):
                    self.status_var.set(f"Merging: {os.path.basename(pdf)}  ({i + 1}/{total})")
                    merger.append(pdf)
                    self.frame.after(0, lambda v=((i + 1) / total * 100): self._set_progress(v))
                merger.write(output_path)
                merger.close()
                self.frame.after(0, self._on_merge_success, output_path)
            except Exception as e:
                self.frame.after(0, self._on_merge_fail, str(e))

        threading.Thread(target=_run, daemon=True).start()

    def _set_progress(self, value):
        self.progress["value"] = value

    def _on_merge_success(self, path):
        self.progress["value"] = 100
        self.merge_btn.config(state=tk.NORMAL)
        self.status_var.set(f"✅ Merged successfully → {path}")
        messagebox.showinfo("Success", f"✅ PDFs merged successfully!\n\nSaved to:\n{path}")

    def _on_merge_fail(self, err):
        self.progress["value"] = 0
        self.merge_btn.config(state=tk.NORMAL)
        self.status_var.set("❌ Merge failed.")
        messagebox.showerror("Error", f"Failed to merge PDFs:\n{err}")

    def _update_status(self):
        n = len(self.pdf_files)
        self.status_var.set(f"{n} file(s) loaded." if n else "Ready – add PDF files to get started.")


# ══════════════════════════════════════════════════════════════════
#  TAB 2 ── PDF Unprotect
# ══════════════════════════════════════════════════════════════════
class UnprotectTab:
    def __init__(self, parent):
        self.frame = tk.Frame(parent, bg="#2c3e50")

        self.input_file   = tk.StringVar()
        self.output_file  = tk.StringVar()
        self.password     = tk.StringVar()
        self.show_pass    = tk.BooleanVar(value=False)

        self.build_ui()
        self._check_libraries()

    # ── UI ────────────────────────────────────────────────────────
    def build_ui(self):
        # Title
        tk.Label(
            self.frame,
            text="🔓 PDF Unprotect",
            font=("Helvetica", 20, "bold"),
            fg="#ecf0f1",
            bg="#2c3e50",
        ).pack(pady=(18, 2))

        tk.Label(
            self.frame,
            text="Remove password protection from secured PDF files.",
            font=("Helvetica", 9),
            fg="#bdc3c7",
            bg="#2c3e50",
        ).pack(pady=(0, 10))

        # ── Main Card ──
        card = tk.Frame(self.frame, bg="#34495e")
        card.pack(padx=25, pady=4, fill="both", expand=True)

        def _section(label_text):
            tk.Label(
                card,
                text=label_text,
                font=("Helvetica", 11, "bold"),
                fg="#ecf0f1",
                bg="#34495e",
            ).pack(anchor="w", padx=20, pady=(15, 4))

        def _row():
            f = tk.Frame(card, bg="#34495e")
            f.pack(fill="x", padx=20)
            return f

        def _entry(parent, textvariable, show=""):
            return tk.Entry(
                parent,
                textvariable=textvariable,
                font=("Helvetica", 10),
                bg="#2c3e50",
                fg="#ecf0f1",
                insertbackground="white",
                relief="flat",
                bd=5,
                show=show,
            )

        def _browse_btn(parent, command):
            return tk.Button(
                parent,
                text="Browse",
                command=command,
                bg="#3498db",
                fg="white",
                font=("Helvetica", 10, "bold"),
                relief="flat",
                cursor="hand2",
                padx=10,
            )

        # Input
        _section("📂 Input PDF File:")
        row1 = _row()
        _entry(row1, self.input_file).pack(side="left", fill="x", expand=True, ipady=5)
        _browse_btn(row1, self.browse_input).pack(side="right", padx=(6, 0), ipady=5)

        # Password
        _section("🔑 PDF Password:")
        row2 = _row()
        self.pass_entry = _entry(row2, self.password, show="*")
        self.pass_entry.pack(side="left", fill="x", expand=True, ipady=5)
        tk.Checkbutton(
            row2,
            text="Show",
            variable=self.show_pass,
            command=self.toggle_password,
            bg="#34495e",
            fg="#ecf0f1",
            selectcolor="#2c3e50",
            activebackground="#34495e",
            activeforeground="#ecf0f1",
            font=("Helvetica", 10),
            cursor="hand2",
        ).pack(side="right", padx=(6, 0))

        # Output
        _section("💾 Output PDF File:")
        row3 = _row()
        _entry(row3, self.output_file).pack(side="left", fill="x", expand=True, ipady=5)
        _browse_btn(row3, self.browse_output).pack(side="right", padx=(6, 0), ipady=5)

        # Unlock button
        self.unlock_btn = tk.Button(
            card,
            text="🔓  Unlock PDF",
            command=self.start_unlock,
            bg="#27ae60",
            fg="white",
            font=("Helvetica", 13, "bold"),
            relief="flat",
            cursor="hand2",
            padx=20,
            pady=10,
        )
        self.unlock_btn.pack(pady=22)

        # Progress
        self.progress = ttk.Progressbar(
            card, orient="horizontal", length=450, mode="indeterminate"
        )
        self.progress.pack(pady=(0, 16))

        # Status
        self.status_var = tk.StringVar(value="Ready")
        tk.Label(
            self.frame,
            textvariable=self.status_var,
            font=("Helvetica", 8),
            fg="#bdc3c7",
            bg="#2c3e50",
            anchor="w",
        ).pack(fill="x", padx=25, pady=(4, 0))

    # ── Helpers ───────────────────────────────────────────────────
    def _check_libraries(self):
        if not PIKEPDF_AVAILABLE and not PYPDF2_AVAILABLE:
            messagebox.showerror(
                "Missing Libraries",
                "No PDF library found!\n\nPlease install:\n  pip install pikepdf\n  pip install PyPDF2",
            )
            self.unlock_btn.config(state=tk.DISABLED)
        else:
            lib = "pikepdf" if PIKEPDF_AVAILABLE else "PyPDF2"
            self.status_var.set(f"Ready | Using: {lib}")

    def toggle_password(self):
        self.pass_entry.config(show="" if self.show_pass.get() else "*")

    def browse_input(self):
        path = filedialog.askopenfilename(
            title="Select Secured PDF File",
            filetypes=[("PDF Files", "*.pdf"), ("All Files", "*.*")],
        )
        if path:
            self.input_file.set(path)
            base, ext = os.path.splitext(path)
            self.output_file.set(f"{base}_unlocked{ext}")

    def browse_output(self):
        path = filedialog.asksaveasfilename(
            title="Save Unlocked PDF As",
            defaultextension=".pdf",
            filetypes=[("PDF Files", "*.pdf"), ("All Files", "*.*")],
        )
        if path:
            self.output_file.set(path)

    def start_unlock(self):
        if not self.input_file.get():
            messagebox.showwarning("Warning", "Please select an input PDF file.")
            return
        if not self.output_file.get():
            messagebox.showwarning("Warning", "Please specify an output file path.")
            return
        if not os.path.exists(self.input_file.get()):
            messagebox.showerror("Error", "Input file does not exist.")
            return

        self.unlock_btn.config(state=tk.DISABLED)
        self.progress.start(10)
        self.status_var.set("Unlocking PDF, please wait…")
        threading.Thread(target=self._unlock_pdf, daemon=True).start()

    def _unlock_pdf(self):
        inp  = self.input_file.get()
        out  = self.output_file.get()
        pwd  = self.password.get()
        try:
            if PIKEPDF_AVAILABLE:
                self._unlock_pikepdf(inp, out, pwd)
            elif PYPDF2_AVAILABLE:
                self._unlock_pypdf2(inp, out, pwd)
            else:
                raise Exception("No PDF library available.")
            self.frame.after(0, self._on_success, out)
        except Exception as e:
            self.frame.after(0, self._on_failure, str(e))

    def _unlock_pikepdf(self, inp, out, pwd):
        try:
            pdf = pikepdf.open(inp, password=pwd)
            pdf.save(out)
            pdf.close()
        except pikepdf.PasswordError:
            raise Exception("Incorrect password. Please try again.")
        except Exception as e:
            raise Exception(f"pikepdf error: {e}")

    def _unlock_pypdf2(self, inp, out, pwd):
        reader = PdfReader(inp)
        if reader.is_encrypted:
            if reader.decrypt(pwd) == 0:
                raise Exception("Incorrect password. Please try again.")
        writer = PdfWriter()
        for page in reader.pages:
            writer.add_page(page)
        with open(out, "wb") as fh:
            writer.write(fh)

    def _on_success(self, path):
        self.progress.stop()
        self.unlock_btn.config(state=tk.NORMAL)
        self.status_var.set(f"✅ Unlocked successfully → {path}")
        messagebox.showinfo("Success", f"PDF unlocked successfully!\n\nSaved to:\n{path}")

    def _on_failure(self, err):
        self.progress.stop()
        self.unlock_btn.config(state=tk.NORMAL)
        self.status_var.set(f"❌ Failed: {err}")
        messagebox.showerror("Error", f"Failed to unlock PDF:\n\n{err}")


# ══════════════════════════════════════════════════════════════════
#  MAIN APPLICATION
# ══════════════════════════════════════════════════════════════════
class PDFToolApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("PDF Tool Suite")
        self.root.geometry("640x580")
        self.root.resizable(False, False)
        self.root.configure(bg="#2c3e50")

        self._setup_style()
        self._build_ui()

    def _setup_style(self):
        style = ttk.Style()
        style.theme_use("clam")
        # Progress bars
        style.configure(
            "TProgressbar",
            troughcolor="#1a252f",
            background="#27ae60",
            thickness=8,
        )
        # Notebook (tabs)
        style.configure(
            "Custom.TNotebook",
            background="#2c3e50",
            borderwidth=0,
        )
        style.configure(
            "Custom.TNotebook.Tab",
            background="#1a252f",
            foreground="#bdc3c7",
            font=("Helvetica", 11, "bold"),
            padding=(20, 8),
            borderwidth=0,
        )
        style.map(
            "Custom.TNotebook.Tab",
            background=[("selected", "#3498db")],
            foreground=[("selected", "white")],
        )

    def _build_ui(self):
        # ── App Header ──
        header = tk.Frame(self.root, bg="#1a252f", pady=10)
        header.pack(fill="x")

        tk.Label(
            header,
            text="📑  PDF Tool Suite",
            font=("Helvetica", 16, "bold"),
            fg="#ecf0f1",
            bg="#1a252f",
        ).pack(side="left", padx=20)

        tk.Label(
            header,
            text="Merge  •  Unprotect",
            font=("Helvetica", 9),
            fg="#7f8c8d",
            bg="#1a252f",
        ).pack(side="right", padx=20)

        # ── Tabbed Notebook ──
        self.notebook = ttk.Notebook(self.root, style="Custom.TNotebook")
        self.notebook.pack(fill="both", expand=True, padx=0, pady=0)

        merger_tab    = MergerTab(self.notebook)
        unprotect_tab = UnprotectTab(self.notebook)

        self.notebook.add(merger_tab.frame,    text="  🔗 Merge PDFs  ")
        self.notebook.add(unprotect_tab.frame, text="  🔓 Unprotect PDF  ")

        # ── Footer Status Bar ──
        footer = tk.Frame(self.root, bg="#1a252f", height=24)
        footer.pack(fill="x", side="bottom")

        libs = []
        if PIKEPDF_AVAILABLE:  libs.append("pikepdf ✔")
        if PYPDF2_AVAILABLE:   libs.append("PyPDF2 ✔")
        if not libs:           libs.append("⚠ No PDF library found")

        tk.Label(
            footer,
            text="  |  ".join(libs),
            font=("Helvetica", 8),
            fg="#7f8c8d",
            bg="#1a252f",
            anchor="w",
        ).pack(fill="x", padx=12, pady=4)


# ══════════════════════════════════════════════════════════════════
#  Entry Point
# ══════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    root = tk.Tk()
    app  = PDFToolApp(root)
    root.mainloop()

