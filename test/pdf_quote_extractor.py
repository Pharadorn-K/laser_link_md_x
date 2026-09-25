"""
PDF Quoted-Text Extractor
--------------------------
A small Tkinter app that:
  1. Lets you pick a .pdf file
  2. Extracts all text from every page
  3. Finds every substring wrapped in double quotes, e.g. "P41500218_"
  4. Shows the matches in a list (with counts) and lets you copy/save them

Requirements:
    pip install pypdf

Run:
    python pdf_quote_extractor.py
"""

import re
import tkinter as tk
from tkinter import filedialog, messagebox
from collections import Counter

try:
    from pypdf import PdfReader
except ImportError:
    raise ImportError("Please install pypdf first:  pip install pypdf")


# Matches anything between two double quotes (non-greedy, no embedded quotes)
QUOTE_PATTERN = re.compile(r'"([^"]+)"')


class PDFQuoteExtractorApp:
    def __init__(self, root):
        self.root = root
        self.root.title("PDF Quoted-Text Extractor")
        self.root.geometry("600x550")

        self.pdf_path = None
        self.full_text = ""
        self.matches = []

        self._build_ui()

    # ---------- UI ----------
    def _build_ui(self):
        top_frame = tk.Frame(self.root, pady=10)
        top_frame.pack(fill="x")

        self.path_label = tk.Label(top_frame, text="No PDF selected", fg="gray", anchor="w")
        self.path_label.pack(side="left", padx=10, fill="x", expand=True)

        browse_btn = tk.Button(top_frame, text="Select PDF...", command=self.select_pdf)
        browse_btn.pack(side="right", padx=10)

        extract_btn = tk.Button(self.root, text="Extract", command=self.extract_quotes,
                                 bg="#4CAF50", fg="white", pady=5)
        extract_btn.pack(fill="x", padx=10, pady=(0, 10))

        # Vertical split: block 1 (all text) on top, block 2 (quoted words) on bottom
        paned = tk.PanedWindow(self.root, orient="vertical", sashrelief="raised", sashwidth=6)
        paned.pack(fill="both", expand=True, padx=10, pady=(0, 5))

        # ---- Block 1: All text found ----
        block1 = tk.Frame(paned)
        tk.Label(block1, text="1. All text found:", anchor="w", font=("Arial", 10, "bold")).pack(fill="x")

        text_frame = tk.Frame(block1)
        text_frame.pack(fill="both", expand=True)

        text_scroll = tk.Scrollbar(text_frame)
        text_scroll.pack(side="right", fill="y")

        self.text_box = tk.Text(text_frame, yscrollcommand=text_scroll.set, font=("Consolas", 10), wrap="word")
        self.text_box.pack(side="left", fill="both", expand=True)
        text_scroll.config(command=self.text_box.yview)

        paned.add(block1, stretch="always")

        # ---- Block 2: Words in "" ----
        block2 = tk.Frame(paned)
        tk.Label(block2, text='2. Words in "":', anchor="w", font=("Arial", 10, "bold")).pack(fill="x")

        list_frame = tk.Frame(block2)
        list_frame.pack(fill="both", expand=True)

        scrollbar = tk.Scrollbar(list_frame)
        scrollbar.pack(side="right", fill="y")

        self.listbox = tk.Listbox(list_frame, yscrollcommand=scrollbar.set, font=("Consolas", 10))
        self.listbox.pack(side="left", fill="both", expand=True)
        scrollbar.config(command=self.listbox.yview)

        self.count_label = tk.Label(block2, text="", fg="gray", anchor="w")
        self.count_label.pack(fill="x")

        paned.add(block2, stretch="always")

        # Bottom buttons
        bottom_frame = tk.Frame(self.root, pady=10)
        bottom_frame.pack(fill="x")

        tk.Button(bottom_frame, text="Copy Quoted Words", command=self.copy_all).pack(side="left", padx=10)
        tk.Button(bottom_frame, text="Save Quoted Words to .txt", command=self.save_to_file).pack(side="left")
        tk.Button(bottom_frame, text="Save Full Text to .txt", command=self.save_full_text).pack(side="left")
        tk.Button(bottom_frame, text="Clear", command=self.clear_results).pack(side="right", padx=10)

    # ---------- Logic ----------
    def select_pdf(self):
        path = filedialog.askopenfilename(
            title="Select a PDF file",
            filetypes=[("PDF files", "*.pdf")]
        )
        if path:
            self.pdf_path = path
            self.path_label.config(text=path, fg="black")

    def extract_quotes(self):
        if not self.pdf_path:
            messagebox.showwarning("No file", "Please select a PDF file first.")
            return

        try:
            reader = PdfReader(self.pdf_path)
            text_chunks = []
            for page in reader.pages:
                page_text = page.extract_text() or ""
                text_chunks.append(page_text)
            self.full_text = "\n".join(text_chunks)
        except Exception as e:
            messagebox.showerror("Error reading PDF", str(e))
            return

        self.matches = QUOTE_PATTERN.findall(self.full_text)

        # --- Block 1: show all extracted text ---
        self.text_box.delete("1.0", tk.END)
        self.text_box.insert("1.0", self.full_text if self.full_text else "(No text could be extracted.)")

        # --- Block 2: show quoted words ---
        self.listbox.delete(0, tk.END)
        if not self.matches:
            self.count_label.config(text="No quoted text found.")
            return

        # Count occurrences, show unique values with counts, most frequent first
        counts = Counter(self.matches)
        for value, n in counts.most_common():
            display = f'"{value}"' if n == 1 else f'"{value}"   (x{n})'
            self.listbox.insert(tk.END, display)

        self.count_label.config(
            text=f"{len(self.matches)} total match(es), {len(counts)} unique."
        )

    def copy_all(self):
        if not self.matches:
            messagebox.showinfo("Nothing to copy", "No matches to copy yet.")
            return
        text = "\n".join(self.matches)
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        messagebox.showinfo("Copied", "All matches copied to clipboard.")

    def save_to_file(self):
        if not self.matches:
            messagebox.showinfo("Nothing to save", "No matches to save yet.")
            return
        out_path = filedialog.asksaveasfilename(
            defaultextension=".txt",
            filetypes=[("Text files", "*.txt")],
            title="Save matches as..."
        )
        if out_path:
            with open(out_path, "w", encoding="utf-8") as f:
                f.write("\n".join(self.matches))
            messagebox.showinfo("Saved", f"Matches saved to:\n{out_path}")

    def save_full_text(self):
        if not self.full_text:
            messagebox.showinfo("Nothing to save", "No extracted text yet.")
            return
        out_path = filedialog.asksaveasfilename(
            defaultextension=".txt",
            filetypes=[("Text files", "*.txt")],
            title="Save full text as..."
        )
        if out_path:
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(self.full_text)
            messagebox.showinfo("Saved", f"Full text saved to:\n{out_path}")

    def clear_results(self):
        self.text_box.delete("1.0", tk.END)
        self.listbox.delete(0, tk.END)
        self.count_label.config(text="")
        self.full_text = ""
        self.matches = []


if __name__ == "__main__":
    root = tk.Tk()
    app = PDFQuoteExtractorApp(root)
    root.mainloop()