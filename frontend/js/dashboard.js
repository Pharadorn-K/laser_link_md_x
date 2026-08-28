// frontend/js/dashboard.js
// ============================================================
// dashboard.js
// Sectioned: COMMON, then one section per page. Add new sections
// as new pages/*.html get built out.
// ============================================================
const API_BASE = "";

/* ============================================================
   COMMON — auth guard, api helper, sidebar routing, topbar
   ============================================================ */
let CURRENT_USER = null;

function authToken() {
  return localStorage.getItem("nlm_token");
}

async function apiFetch(path, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  const token = authToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${API_BASE}${path}`, Object.assign({}, options, { headers }));
  if (res.status === 401) {
    localStorage.removeItem("nlm_token");
    localStorage.removeItem("nlm_user");
    window.location.href = "login.html";
    throw new Error("Not authenticated");
  }
  return res;
}

const PAGE_TITLES = {
  monitor: "Monitor",
  model_setting: "Model Setting",
  work_mode: "Work Mode",
  alarm_center: "Alarm Center",
  equipment: "Equipment",
  profile: "Profile",
  all_user: "Users",
};

// Per-page init hooks, filled in by each section below.
const PAGE_INIT = {};
// Per-page teardown hooks (e.g. stop polling) when navigating away.
const PAGE_TEARDOWN = {};

let activePage = null;

async function loadPage(page) {
  if (page === "equipment" || page === "all_user") {
    if (!CURRENT_USER || CURRENT_USER.role !== "admin") return;
  }

  if (activePage && PAGE_TEARDOWN[activePage]) PAGE_TEARDOWN[activePage]();
  activePage = page;

  document.querySelectorAll(".nav-link").forEach((el) => {
    el.classList.toggle("active", el.dataset.page === page);
  });
  document.getElementById("topbar-title").textContent = PAGE_TITLES[page] || page;

  const content = document.getElementById("content");
  content.innerHTML = `<div class="page-placeholder">Loading…</div>`;
  try {
    const res = await fetch(`pages/${page}.html`);
    content.innerHTML = await res.text();
  } catch (err) {
    content.innerHTML = `<div class="alert alert-error">Could not load this page.</div>`;
    return;
  }
  if (PAGE_INIT[page]) PAGE_INIT[page]();
}

function initShell() {
  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.addEventListener("click", () => loadPage(btn.dataset.page));
  });
  document.getElementById("logout-btn").addEventListener("click", () => {
    localStorage.removeItem("nlm_token");
    localStorage.removeItem("nlm_user");
    window.location.href = "login.html";
  });
}

function applyUserToChrome(user) {
  CURRENT_USER = user;
  document.getElementById("topbar-username").textContent = user.name;
  document.getElementById("topbar-role").textContent = user.role.toUpperCase();
  if (user.photo_path) {
    document.getElementById("topbar-avatar").src = user.photo_path;
  }
  document.querySelectorAll('.nav-link[data-admin-only]').forEach((el) => {
    el.style.display = user.role === "admin" ? "" : "none";
  });
}

async function bootstrap() {
  if (!authToken()) {
    window.location.href = "login.html";
    return;
  }
  initShell();
  try {
    const res = await apiFetch("/api/auth/me");
    if (!res.ok) throw new Error("me failed");
    const user = await res.json();
    applyUserToChrome(user);
    localStorage.setItem("nlm_user", JSON.stringify(user));
  } catch (err) {
    window.location.href = "login.html";
    return;
  }
  loadPage("monitor");
}

document.addEventListener("DOMContentLoaded", bootstrap);

/* ============================================================
  SHARED STATE — currently selected job/condition per pallet.
   Set from the Model Setting page, read by any other page (e.g.
   Equipment) that needs to know "what command runs right now
  for Pallet1 / Pallet2". Persisted to localStorage so it
   survives page navigation and reloads.
   ============================================================ */

// Fixed CharacterString/BLK slot pairs — must match model.controller.js
// CONDITION_FIELDS on the backend and the model_condition table columns.
// Small shared HTML-escape helper (dashboard.js has no equivalent yet).
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}

function padJob(n) {
  return String(n).padStart(4, "0");
}
function padBlk(n) {
  return String(n).padStart(3, "0");
}

// Builds the base command string for a model_condition row, e.g.
// "JobNo=0001,BLK=001,CharacterString=G,BLK=002,CharacterString=K9L"
function buildBaseCommand(condition) {
  if (!condition) return "";
  const parts = [`JobNo=${padJob(condition.job_no)}`];
  (condition.conditions || []).forEach((item) => {
    parts.push(`BLK=${padBlk(item.block_no)}`);
    parts.push(`CharacterString=${item.condition_value}`);
  });
  return parts.join(",");
}

function getSelectedJobs() {
  try {
    return JSON.parse(localStorage.getItem("nlm_selected_jobs") || "{}");
  } catch (err) {
    return {};
  }
}

function setSelectedJob(station, condition) {
  const all = getSelectedJobs();
  if (condition) {
    all[station] = condition;
  } else {
    delete all[station];
  }
  localStorage.setItem("nlm_selected_jobs", JSON.stringify(all));
}

function getSelectedJob(station) {
  return getSelectedJobs()[station] || null;
}

function getSelectedJobCommand(station) {
  return buildBaseCommand(getSelectedJob(station));
}

/* ============================================================
   FOR MONITOR PAGE — placeholder, nothing to initialize yet
   ============================================================ */
PAGE_INIT.monitor = function () {};

/* ============================================================
   FOR WORK MODE PAGE
   ============================================================ */
const WM_MODE_KEY = "nlm_work_mode";
const WM_STEPS = [
  { id: "open_door",   label: "Open door" },
  { id: "wait_start",  label: "Wait for start signal" },
  { id: "close_door",  label: "Close door" },
  { id: "check_cam",   label: "Check camera" },
  { id: "change_pallet", label: "Change pallet (Cyl.1 out / Cyl.2 in)" },
  { id: "start_mark",  label: "Start marking" },
];

const WM = {
  mode: null,       // "MANUAL" | "AUTO1-2" | "AUTO1" | "AUTO2" | null
  seqRunning: false,
  seqTimer: null,
  seqIndex: -1,
};

function wmLoadMode() {
  return localStorage.getItem(WM_MODE_KEY) || null;
}
function wmSaveMode(mode) {
  if (mode) localStorage.setItem(WM_MODE_KEY, mode);
  else localStorage.removeItem(WM_MODE_KEY);
}

function wmLog(message, kind = "info") {
  const log = document.getElementById("wm-manual-log");
  if (!log) return;
  const ts = new Date().toLocaleTimeString();
  const cls = kind === "error" ? "line-err" : kind === "warn" ? "line-warn" : kind === "ok" ? "line-ok" : "";
  const line = document.createElement("div");
  line.className = cls;
  line.textContent = `[${ts}] ${message}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

const WM_CMD_LABELS = {
  door_open: "Open Door",
  door_close: "Close Door",
  cyl1_out: "Cylinder 1: Pallet 1 Out",
  cyl2_in: "Cylinder 2: Pallet 2 In",
  start_marking: "Start Marking",
  stop_marking: "Stop Marking",
  guide_laser: "Guide Laser",
  clear_error: "Clear Error",
};

function wmSimulateCommand(cmdKey, btn) {
  const label = WM_CMD_LABELS[cmdKey] || cmdKey;
  wmLog(`>>> ${label} (simulated — no interlock/equipment connected)`, "warn");
  btn.disabled = true;
  setTimeout(() => {
    wmLog(`<<< ${label}: OK (simulated)`, "ok");
    btn.disabled = false;
  }, 400);
}

function wmRenderPalletStatus() {
  const row = document.getElementById("wm-pallet-status-row");
  if (!row) return;
  const pallets = WM.mode === "AUTO1" ? ["Pallet1"] : WM.mode === "AUTO2" ? ["Pallet2"] : ["Pallet1", "Pallet2"];

  row.innerHTML = pallets.map((p) => {
    const job = getSelectedJob(p);
    const ok = !!job;
    return `
      <div class="wm-pallet-status ${ok ? "ok" : "warn"}">
        <div class="wm-pallet-status-title">${p}</div>
        ${ok
          ? `<div class="mono">${job.model} · Job ${padJob(job.job_no)}</div>`
          : `<div class="wm-pallet-status-alarm">⚠ No model selected for ${p}</div>`}
      </div>`;
  }).join("");
}

function wmSeqStepsForMode() {
  // AUTO1-2 alternates pallets; for the UI mock, just show the shared sequence once.
  return WM_STEPS;
}

function wmRenderSeqList(activeIndex = -1, doneUpTo = -1) {
  const list = document.getElementById("wm-seq-list");
  if (!list) return;
  const steps = wmSeqStepsForMode();
  list.innerHTML = steps.map((s, i) => {
    let stateClass = "pending";
    if (i <= doneUpTo) stateClass = "done";
    else if (i === activeIndex) stateClass = "active";
    return `<li class="wm-seq-step ${stateClass}"><span class="wm-seq-num">${i + 1}</span>${s.label}</li>`;
  }).join("");
}

function wmAllModelsSelected() {
  const pallets = WM.mode === "AUTO1" ? ["Pallet1"] : WM.mode === "AUTO2" ? ["Pallet2"] : ["Pallet1", "Pallet2"];
  return pallets.every((p) => !!getSelectedJob(p));
}

function wmStartSequence() {
  if (!wmAllModelsSelected()) {
    showToast("Select a model for the target pallet(s) before starting.");
    return;
  }
  const steps = wmSeqStepsForMode();
  WM.seqRunning = true;
  WM.seqIndex = 0;
  document.getElementById("wm-start-seq-btn").disabled = true;
  document.getElementById("wm-stop-seq-btn").disabled = false;
  document.getElementById("wm-confirm-seq-btn").disabled = true;
  wmRenderSeqList(0, -1);

  const stepDelayMs = 900;
  const runStep = () => {
    if (!WM.seqRunning) return;
    wmRenderSeqList(WM.seqIndex, WM.seqIndex - 1);
    if (WM.seqIndex >= steps.length) {
      WM.seqRunning = false;
      wmRenderSeqList(-1, steps.length - 1);
      document.getElementById("wm-start-seq-btn").disabled = false;
      document.getElementById("wm-stop-seq-btn").disabled = true;
      document.getElementById("wm-confirm-seq-btn").disabled = false;
      return;
    }
    WM.seqTimer = setTimeout(() => {
      WM.seqIndex += 1;
      runStep();
    }, stepDelayMs);
  };
  runStep();
}

function wmStopSequence() {
  WM.seqRunning = false;
  clearTimeout(WM.seqTimer);
  document.getElementById("wm-start-seq-btn").disabled = false;
  document.getElementById("wm-stop-seq-btn").disabled = true;
  document.getElementById("wm-confirm-seq-btn").disabled = true;
  wmRenderSeqList(-1, -1);
}

function wmApplyMode(mode) {
  WM.mode = mode;
  wmSaveMode(mode);

  const pill = document.getElementById("wm-active-mode-pill");
  pill.textContent = mode ? `Active: ${mode}` : "No mode active";
  pill.classList.toggle("set", !!mode);

  const manualLock = document.getElementById("wm-manual-lock");
  const autoLock = document.getElementById("wm-auto-lock");
  const isManual = mode === "MANUAL";
  const isAuto = mode === "AUTO1-2" || mode === "AUTO1" || mode === "AUTO2";

  manualLock.classList.toggle("show", !isManual);
  autoLock.classList.toggle("show", !isAuto);

  if (isAuto) {
    wmRenderPalletStatus();
    wmRenderSeqList(-1, -1);
  }
  wmStopSequence();
}

PAGE_INIT.work_mode = function () {
  const savedMode = wmLoadMode();
  document.getElementById("wm-mode-select").value = savedMode || "";
  wmApplyMode(savedMode);

  document.getElementById("wm-set-mode-btn").addEventListener("click", () => {
    const value = document.getElementById("wm-mode-select").value;
    if (!value) { showToast("Choose a mode first."); return; }
    wmApplyMode(value);
    showToast(`Mode set to ${value}.`, "success");
  });

  document.querySelectorAll(".wm-cmd-btn").forEach((btn) => {
    btn.addEventListener("click", () => wmSimulateCommand(btn.dataset.cmd, btn));
  });
  document.getElementById("wm-clear-log-btn").addEventListener("click", () => {
    document.getElementById("wm-manual-log").innerHTML = "";
  });

  document.getElementById("wm-start-seq-btn").addEventListener("click", wmStartSequence);
  document.getElementById("wm-stop-seq-btn").addEventListener("click", wmStopSequence);
  document.getElementById("wm-confirm-seq-btn").addEventListener("click", () => {
    loadPage("monitor");
  });
};

PAGE_TEARDOWN.work_mode = function () {
  wmStopSequence();
};

/* alarm_center — still a placeholder */
PAGE_INIT.alarm_center = function () {};

/* ============================================================
   TOAST — small popup for permission/notice messages
   ============================================================ */
function showToast(message, type = "error", ms = 2200) {
  let box = document.getElementById("global-toast");
  if (!box) {
    box = document.createElement("div");
    box.id = "global-toast";
    document.body.appendChild(box);
  }
  box.className = `global-toast toast-${type} show`;
  box.textContent = message;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => box.classList.remove("show"), ms);
}

function isAdmin() {
  return CURRENT_USER && CURRENT_USER.role === "admin";
}

/* ============================================================
   FOR MODEL SETTING PAGE
   ============================================================ */
const MS_MAX_CONDITIONS = 20;
const START2D_LABELS = ["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q"];

const MS = {
  data: { Pallet1: [], Pallet2: [] },
  editingId: null,
  conditions: [],
  conditionNameChoices: [],
  pendingSet: null, // {pallet, itemId, newValue, oldValue, name}
};

function msShowAlert(message, type = "error") {
  const box = document.getElementById("ms-alert-box");
  if (box) box.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
}
function msClearAlert() {
  const box = document.getElementById("ms-alert-box");
  if (box) box.innerHTML = "";
}
function msModalAlert(message) {
  document.getElementById("ms-modal-alert").innerHTML = `<div class="alert alert-error">${message}</div>`;
}

async function msLoadConditionNames() {
  try {
    const res = await apiFetch("/api/models/condition-names");
    MS.conditionNameChoices = await res.json();
    const datalist = document.getElementById("ms-condition-names-datalist");
    if (datalist) {
      datalist.innerHTML = MS.conditionNameChoices
        .map((n) => `<option value="${escapeHtml(n)}"></option>`)
        .join("");
    }
  } catch (err) {}
}

async function msLoadPallet(pallet) {
  const res = await apiFetch(`/api/models?pallet=${pallet}`);
  const rows = await res.json();
  MS.data[pallet] = rows;

  const select = document.getElementById(`ms-select-${pallet}`);
  select.innerHTML =
    `<option value="">— select —</option>` +
    rows.map((r) => `<option value="${r.id}">${r.model} · Job ${padJob(r.job_no)}</option>`).join("");

  const saved = getSelectedJob(pallet);
  const stillExists = saved && rows.find((r) => r.id === saved.id);
  if (stillExists) {
    select.value = saved.id;
    msRenderDetail(pallet, stillExists);
    setSelectedJob(pallet, stillExists);
  } else {
    setSelectedJob(pallet, null);
    msRenderDetail(pallet, null);
  }
}

function msBuildStart2DCommand(condition) {
  const params = (condition.start2dcode_params && condition.start2dcode_params.length === 17)
    ? condition.start2dcode_params
    : START2D_LABELS.map(() => "");
  return `WX,Check2DCode5=${params.join(",")}`;
}
function msBuildRead2DCommand(condition) {
  const v = condition.read2dcode_detailed !== undefined && condition.read2dcode_detailed !== null
    ? condition.read2dcode_detailed : "0";
  return `RX,CodeReadResult=${v}`;
}

function msRenderDetail(pallet, condition) {
  const wrap = document.getElementById(`ms-detail-${pallet}`);
  if (!condition) {
    wrap.innerHTML = `<div class="ms-empty">Select a job to see its condition.</div>`;
    return;
  }

  const items = condition.conditions || [];

  const editableRows = items.length
    ? items.map((it) => `
      <div class="ms-cond-edit-row" data-item-id="${it.id}" data-pallet="${pallet}">
        <div class="ms-cond-edit-meta">
          <span class="ms-cond-edit-name">${escapeHtml(it.condition_name)}</span>
          <span class="ms-cond-edit-blk mono">BLK ${padBlk(it.block_no)}</span>
        </div>
        <input type="text" class="ms-cond-edit-input" value="${escapeHtml(it.condition_value)}" />
        <button type="button" class="btn btn-sm btn-primary ms-cond-set-btn">Set</button>
      </div>`).join("")
    : `<div class="eq-queue-empty">No conditions set.</div>`;

  const extras = [];
  if (condition.check_start2dcode) {
    extras.push(`
      <div class="ms-preview-row">
        <span class="ms-preview-label">START 2D CODE COMMAND</span>
        <div class="mono-box">${msBuildStart2DCommand(condition)}</div>
      </div>`);
  }
  if (condition.check_read2dcode) {
    extras.push(`
      <div class="ms-preview-row">
        <span class="ms-preview-label">READ 2D CODE COMMAND</span>
        <div class="mono-box">${msBuildRead2DCommand(condition)}</div>
      </div>`);
  }

  wrap.innerHTML = `
    <table class="data-table ms-detail-table">
      <tbody>
        <tr><td>Model</td><td colspan="2">${escapeHtml(condition.model)}</td></tr>
        <tr><td>Job No.</td><td colspan="2" class="mono">${padJob(condition.job_no)}</td></tr>
        <tr><td>Start 2D Code</td><td colspan="2">${condition.check_start2dcode ? "Yes" : "No"}</td></tr>
        <tr><td>Check Read 2D Code</td><td colspan="2">${condition.check_read2dcode ? "Yes" : "No"}</td></tr>
        <tr><td>Check Grade 2D Code</td><td colspan="2">${condition.check_grade2dcode ? "Yes" : "No"}</td></tr>
        <tr><td>Control Grade</td><td colspan="2">${escapeHtml(condition.control_grade) || "—"}</td></tr>
        <tr><td>Camera</td><td colspan="2">${condition.check_camera ? "Yes" : "No"}</td></tr>
      </tbody>
    </table>
    ${extras.join("")}
    <div class="ms-preview-row">
      <span class="ms-preview-label">BASE COMMAND</span>
      <div class="mono-box">${buildBaseCommand(condition)}</div>
    </div>

    <div class="card-title" style="margin-top:10px;">Conditions <span style="font-weight:400;color:var(--ink-faint);font-size:11px;">(operators can update values)</span></div>
    <div class="ms-cond-edit-list">${editableRows}</div>

    <button type="button" class="btn btn-sm ms-edit-model-btn" data-edit-id="${condition.id}">Edit Model</button>
  `;

  wrap.querySelector(".ms-edit-model-btn").addEventListener("click", () => {
    if (!isAdmin()) { showToast("Only admin can edit models."); return; }
    msOpenModal(condition);
  });

  wrap.querySelectorAll(".ms-cond-set-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".ms-cond-edit-row");
      const itemId = row.dataset.itemId;
      const input = row.querySelector(".ms-cond-edit-input");
      const item = items.find((i) => String(i.id) === String(itemId));
      const newValue = input.value.trim();
      if (!newValue) { showToast("Value cannot be empty."); return; }
      if (newValue === item.condition_value) { showToast("No change.", "info"); return; }

      MS.pendingSet = { pallet, modelId: condition.id, itemId, newValue, oldValue: item.condition_value, name: item.condition_name };
      document.getElementById("ms-confirm-text").textContent =
        `Change "${item.condition_name}" from "${item.condition_value}" to "${newValue}"?`;
      document.getElementById("ms-confirm-backdrop").classList.add("open");
    });
  });
}

async function msConfirmSetValue() {
  const p = MS.pendingSet;
  document.getElementById("ms-confirm-backdrop").classList.remove("open");
  if (!p) return;
  try {
    const res = await apiFetch(`/api/models/${p.modelId}/conditions/${p.itemId}`, {
      method: "PATCH",
      body: JSON.stringify({ condition_value: p.newValue }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || "Update failed.");
      return;
    }
    showToast(`"${p.name}" updated.`, "success");
    await msLoadPallet(p.pallet);
  } catch (err) {
    showToast("Could not reach the server.");
  } finally {
    MS.pendingSet = null;
  }
}

function msConditionRowHtml(index, item) {
  const name = item ? item.condition_name || "" : "";
  const value = item ? item.condition_value || "" : "";
  const block = item && item.block_no !== null && item.block_no !== undefined ? item.block_no : "";
  return `
    <div class="ms-condition-row" data-index="${index}">
      <div class="field">
        <label>Condition Name</label>
        <input type="text" class="ms-cond-name" list="ms-condition-names-datalist"
               value="${escapeHtml(name)}" placeholder="e.g. Heat/Lot No. 1" />
      </div>
      <div class="field">
        <label>CharacterString</label>
        <input type="text" class="ms-cond-value" value="${escapeHtml(value)}" />
      </div>
      <div class="field">
        <label>BLK No.(0-255)</label>
        <input type="number" min="0" max="255" class="ms-cond-block" value="${block}" />
      </div>
      <button type="button" class="btn btn-sm btn-ghost ms-cond-remove" data-index="${index}" title="Remove condition">&times;</button>
    </div>`;
}

function msCaptureConditionsFromDom() {
  const rows = document.querySelectorAll(".ms-condition-row");
  const result = [];
  rows.forEach((row) => {
    result.push({
      condition_name: row.querySelector(".ms-cond-name").value.trim(),
      condition_value: row.querySelector(".ms-cond-value").value.trim(),
      block_no: row.querySelector(".ms-cond-block").value.trim(),
    });
  });
  return result;
}

function msRebuildConditionRows() {
  const wrap = document.getElementById("ms-conditions-wrap");
  wrap.innerHTML = MS.conditions.map((c, i) => msConditionRowHtml(i, c)).join("");
  document.getElementById("ms-add-condition-btn").disabled = MS.conditions.length >= MS_MAX_CONDITIONS;

  wrap.querySelectorAll(".ms-cond-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      MS.conditions = msCaptureConditionsFromDom();
      MS.conditions.splice(Number(btn.dataset.index), 1);
      msRebuildConditionRows();
    });
  });
}

function msBuildStart2DGrid(values) {
  const grid = document.getElementById("ms-start2d-grid");
  grid.innerHTML = START2D_LABELS.map((label, i) => `
    <div class="field">
      <label>${label}</label>
      <input type="text" class="ms-start2d-input" data-index="${i}" value="${escapeHtml((values && values[i]) || "")}" />
    </div>`).join("");
}
function msCaptureStart2DValues() {
  return Array.from(document.querySelectorAll(".ms-start2d-input"))
    .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
    .map((inp) => inp.value.trim());
}

function msToggleCheckParams(checkboxId, wrapId) {
  const cb = document.getElementById(checkboxId);
  const wrap = document.getElementById(wrapId);
  const apply = () => { wrap.style.display = cb.checked ? "" : "none"; };
  cb.addEventListener("change", apply);
  apply();
}

function msOpenModal(condition) {
  msClearAlert();
  document.getElementById("ms-modal-alert").innerHTML = "";
  const form = document.getElementById("ms-model-form");
  form.reset();

  MS.editingId = condition ? condition.id : null;
  document.getElementById("ms-modal-title").textContent = condition ? "Edit Model" : "Add Model";
  document.getElementById("ms-f-id").value = condition ? condition.id : "";
  document.getElementById("ms-f-model").value = condition ? condition.model : "";
  document.getElementById("ms-f-jobno").value = condition ? condition.job_no : "";
  document.getElementById("ms-f-pallet").value = condition ? condition.pallet_no : "Pallet1";

  document.getElementById("ms-f-start2d").checked = condition ? !!condition.check_start2dcode : false;
  msBuildStart2DGrid(condition ? condition.start2dcode_params : null);

  document.getElementById("ms-f-read2d").checked = condition ? !!condition.check_read2dcode : false;
  document.getElementById("ms-f-read2d-detailed").value = condition && condition.read2dcode_detailed !== undefined ? condition.read2dcode_detailed : "0";

  document.getElementById("ms-f-grade2d").checked = condition ? !!condition.check_grade2dcode : true;
  document.getElementById("ms-f-grade").value = condition ? condition.control_grade || "" : "";

  document.getElementById("ms-f-camera").checked = condition ? !!condition.check_camera : true;
  document.getElementById("ms-modal-delete-btn").style.display = condition ? "" : "none";

  msToggleCheckParams("ms-f-start2d", "ms-start2d-params-wrap");
  msToggleCheckParams("ms-f-read2d", "ms-read2d-params-wrap");
  msToggleCheckParams("ms-f-grade2d", "ms-grade2d-params-wrap");

  MS.conditions = condition && condition.conditions && condition.conditions.length
    ? condition.conditions.map((c) => ({ ...c }))
    : [{ condition_name: "", condition_value: "", block_no: "" }];
  msRebuildConditionRows();

  document.getElementById("ms-modal-backdrop").classList.add("open");
}

function msCloseModal() {
  document.getElementById("ms-modal-backdrop").classList.remove("open");
  MS.editingId = null;
}

function msCollectFormPayload() {
  return {
    model: document.getElementById("ms-f-model").value.trim(),
    job_no: document.getElementById("ms-f-jobno").value,
    pallet_no: document.getElementById("ms-f-pallet").value,
    check_start2dcode: document.getElementById("ms-f-start2d").checked,
    start2dcode_params: msCaptureStart2DValues(),
    check_read2dcode: document.getElementById("ms-f-read2d").checked,
    read2dcode_detailed: document.getElementById("ms-f-read2d-detailed").value.trim() || "0",
    check_grade2dcode: document.getElementById("ms-f-grade2d").checked,
    control_grade: document.getElementById("ms-f-grade").value.trim(),
    check_camera: document.getElementById("ms-f-camera").checked,
    conditions: msCaptureConditionsFromDom(),
  };
}

async function msRefreshBothPallets() {
  await Promise.all([msLoadPallet("Pallet1"), msLoadPallet("Pallet2")]);
}

PAGE_INIT.model_setting = function () {
  msClearAlert();
  msLoadConditionNames();
  msRefreshBothPallets();

  document.querySelectorAll(".ms-pallet-select").forEach((select) => {
    select.addEventListener("change", () => {
      const pallet = select.dataset.pallet;
      const id = select.value;
      const condition = MS.data[pallet].find((r) => String(r.id) === id) || null;
      setSelectedJob(pallet, condition);
      msRenderDetail(pallet, condition);
    });
  });

  document.getElementById("ms-add-model-btn").addEventListener("click", () => {
    if (!isAdmin()) { showToast("Only admin can add models."); return; }
    msOpenModal(null);
  });
  document.getElementById("ms-modal-cancel-btn").addEventListener("click", msCloseModal);
  document.getElementById("ms-modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "ms-modal-backdrop") msCloseModal();
  });

  document.getElementById("ms-confirm-yes-btn").addEventListener("click", msConfirmSetValue);
  document.getElementById("ms-confirm-no-btn").addEventListener("click", () => {
    document.getElementById("ms-confirm-backdrop").classList.remove("open");
    MS.pendingSet = null;
  });
  document.getElementById("ms-confirm-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "ms-confirm-backdrop") {
      document.getElementById("ms-confirm-backdrop").classList.remove("open");
      MS.pendingSet = null;
    }
  });

  document.getElementById("ms-add-condition-btn").addEventListener("click", () => {
    if (MS.conditions.length >= MS_MAX_CONDITIONS) return;
    MS.conditions = msCaptureConditionsFromDom();
    MS.conditions.push({ condition_name: "", condition_value: "", block_no: "" });
    msRebuildConditionRows();
  });

  document.getElementById("ms-modal-delete-btn").addEventListener("click", async () => {
    if (!isAdmin()) { showToast("Only admin can delete models."); return; }
    if (!MS.editingId) return;
    if (!confirm("Delete this model condition?")) return;
    try {
      const res = await apiFetch(`/api/models/${MS.editingId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        msModalAlert(data.error || "Delete failed.");
        return;
      }
      msCloseModal();
      await msRefreshBothPallets();
    } catch (err) {
      msModalAlert("Could not reach the server.");
    }
  });

  document.getElementById("ms-model-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!isAdmin()) { showToast("Only admin can save models."); return; }
    document.getElementById("ms-modal-alert").innerHTML = "";
    const payload = msCollectFormPayload();

    try {
      const res = MS.editingId
        ? await apiFetch(`/api/models/${MS.editingId}`, { method: "PUT", body: JSON.stringify(payload) })
        : await apiFetch(`/api/models`, { method: "POST", body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) {
        msModalAlert(data.error || "Save failed.");
        return;
      }
      msCloseModal();
      await msRefreshBothPallets();
      await msLoadConditionNames();
      msShowAlert("Model condition saved.", "success");
    } catch (err) {
      msModalAlert("Could not reach the server.");
    }
  });
};
/* ============================================================
   FOR EQUIPMENT PAGE
   ============================================================ */
const EQ = {
  commandGroups: null,
  currentGroup: null,
  currentMode: null,
  pollTimer: null,
};

function eqFormatParam(raw, fmt) {
  raw = (raw || "").trim();
  if (!fmt) return raw;
  const m = fmt.match(/^(0)?(\d+)(?:\.(\d+))?([df])$/);
  if (!m) return raw;
  const zeroFlag = !!m[1];
  const width = parseInt(m[2], 10);
  const precision = m[3] !== undefined ? parseInt(m[3], 10) : 6;
  const kind = m[4];

  let num = kind === "d" ? parseInt(raw, 10) : parseFloat(raw);
  if (Number.isNaN(num)) throw new Error(`invalid value`);

  const sign = num < 0 ? "-" : "";
  let body = kind === "d" ? Math.abs(num).toString() : Math.abs(num).toFixed(precision);

  if (zeroFlag) {
    while (sign.length + body.length < width) body = "0" + body;
    return sign + body;
  }
  let full = sign + body;
  while (full.length < width) full = " " + full;
  return full;
}

async function eqLoadCommands() {
  const res = await apiFetch("/api/equipment/commands");
  EQ.commandGroups = await res.json();
  const catSelect = document.getElementById("eq-cat-select");
  catSelect.innerHTML = Object.keys(EQ.commandGroups)
    .map((cat) => `<option value="${cat}">${cat}</option>`)
    .join("");
  eqOnCategoryChange();
}

function eqFindGroup(cat, name) {
  return (EQ.commandGroups[cat] || []).find((g) => g.name === name);
}

function eqOnCategoryChange() {
  const cat = document.getElementById("eq-cat-select").value;
  const names = (EQ.commandGroups[cat] || []).map((g) => g.name);
  const cmdSelect = document.getElementById("eq-cmd-select");
  cmdSelect.innerHTML = names.map((n) => `<option value="${n}">${n}</option>`).join("");
  eqOnCommandChange();
}

function eqOnCommandChange() {
  const cat = document.getElementById("eq-cat-select").value;
  const cmdName = document.getElementById("eq-cmd-select").value;
  const group = eqFindGroup(cat, cmdName);
  if (!group) return;
  EQ.currentGroup = group;

  const hasWx = !!group.wx;
  const hasRx = !!group.rx;
  const wxBtn = document.getElementById("eq-mode-wx");
  const rxBtn = document.getElementById("eq-mode-rx");

  wxBtn.disabled = !hasWx;
  rxBtn.disabled = !hasRx;

  let mode = EQ.currentMode;
  if (!mode || !group[mode]) mode = hasWx ? "wx" : "rx";
  eqSetMode(mode);
}

function eqSetMode(mode) {
  const group = EQ.currentGroup;
  if (!group || !group[mode]) mode = group.wx ? "wx" : "rx";
  EQ.currentMode = mode;

  document.getElementById("eq-mode-wx").classList.toggle("active", mode === "wx");
  document.getElementById("eq-mode-rx").classList.toggle("active", mode === "rx");

  const tag = mode === "wx" ? "[WX / Set]" : "[RX / Get]";
  document.getElementById("eq-cmd-desc").textContent = `${tag}  ${group.desc || ""}`;

  eqRebuildParamGrid(group[mode].params || []);
}

function eqRebuildParamGrid(params) {
  const grid = document.getElementById("eq-param-grid");
  if (params.length === 0) {
    grid.innerHTML = `<div class="eq-param-empty">(No parameters)</div>`;
    eqUpdatePreview();
    return;
  }
  grid.innerHTML = params
    .map((p, i) => {
      const [label, defaultVal, width] = p;
      return `
        <div class="field">
          <label>${label}</label>
          <input type="text" class="mono eq-param-input" data-index="${i}" value="${defaultVal}" size="${width}" />
        </div>`;
    })
    .join("");
  grid.querySelectorAll(".eq-param-input").forEach((inp) => {
    inp.addEventListener("input", eqUpdatePreview);
  });
  eqUpdatePreview();
}

function eqUpdatePreview() {
  const box = document.getElementById("eq-preview-box");
  const group = EQ.currentGroup;
  const mode = EQ.currentMode;
  if (!group || !mode) return;
  const entry = group[mode];
  const params = entry.params || [];
  const inputs = document.querySelectorAll(".eq-param-input");

  try {
    let cmd = entry.template;
    params.forEach((p, i) => {
      const raw = inputs[i] ? inputs[i].value : p[1];
      const fmt = p[3];
      const value = eqFormatParam(raw, fmt);
      cmd = cmd.replaceAll(`{p${i}}`, value);
    });
    box.textContent = cmd;
    box.classList.remove("invalid");
  } catch (err) {
    box.textContent = "(invalid parameter value)";
    box.classList.add("invalid");
  }
}

function eqGetIpPort() {
  return {
    ip: document.getElementById("eq-ip").value.trim(),
    port: parseInt(document.getElementById("eq-port").value.trim(), 10),
  };
}

function eqSetStatusPill(state) {
  // state: 'ready' | 'busy' | 'error' | 'offline'
  const pill = document.getElementById("eq-status-pill");
  const labels = { ready: "Ready", busy: "Busy", error: "Error", offline: "Offline" };
  pill.className = `status-pill ${state}`;
  pill.innerHTML = `<span class="dot"></span> ${labels[state]}`;
}

function eqAppendLogLines(lines) {
  const log = document.getElementById("eq-log");
  if (!log) return;
  log.innerHTML = lines
    .map((line) => {
      let cls = "";
      if (line.includes("!!!")) cls = "line-err";
      else if (line.includes("[retry") || line.includes("[warn")) cls = "line-warn";
      else if (line.includes("<<<")) cls = "line-ok";
      return `<div class="${cls}">${line.replace(/</g, "&lt;")}</div>`;
    })
    .join("");
  log.scrollTop = log.scrollHeight;
}

function eqRenderQueue(items) {
  const list = document.getElementById("eq-queue-list");
  if (!items || items.length === 0) {
    list.innerHTML = `<li class="eq-queue-empty">Queue is empty.</li>`;
    return;
  }
  const icons = { pending: "\u23f3", processing: "\ud83d\udd04", failed: "\u274c" };
  list.innerHTML = items
    .map(
      (it) => `
      <li class="${it.status}">
        <span>${icons[it.status] || "?"} Job ${String(it.program_no).padStart(4, "0")}
          <span class="job-status">(${it.status})</span></span>
        ${it.status !== "processing" ? `<button class="btn btn-sm btn-ghost" onclick="eqRemoveQueueItem(${it.id})">Remove</button>` : ""}
      </li>`
    )
    .join("");
}

async function eqRemoveQueueItem(id) {
  await apiFetch(`/api/equipment/queue/${id}`, { method: "DELETE" });
  eqPollStatus();
}
window.eqRemoveQueueItem = eqRemoveQueueItem;

async function eqPollStatus() {
  try {
    const res = await apiFetch("/api/equipment/status");
    const data = await res.json();
    eqAppendLogLines(data.log || []);
    eqRenderQueue(data.queue || []);
    if (data.connection) {
      eqSetStatusPill(data.connection.connected ? "ready" : "offline");
    }
  } catch (err) {
    // silent; next poll will retry
  }
}

function eqBuildJobButtons() {
  const wrap = document.getElementById("eq-job-buttons");
  wrap.innerHTML = [1, 2, 3, 4]
    .map((n) => `<button type="button" class="eq-job-btn" data-job="${n}">Job ${String(n).padStart(4, "0")}</button>`)
    .join("");
  wrap.querySelectorAll(".eq-job-btn").forEach((btn) => {
    btn.addEventListener("click", () => eqAddJob(parseInt(btn.dataset.job, 10)));
  });
}

async function eqAddJob(programNo) {
  const { ip, port } = eqGetIpPort();
  await apiFetch("/api/equipment/queue", {
    method: "POST",
    body: JSON.stringify({ ip, port, program_no: programNo }),
  });
  eqPollStatus();
}

PAGE_INIT.equipment = function () {
  eqBuildJobButtons();
  eqLoadCommands();

  document.getElementById("eq-connect-btn").addEventListener("click", async () => {
    const { ip, port } = eqGetIpPort();
    eqSetStatusPill("busy");
    const res = await apiFetch("/api/equipment/connect", {
      method: "POST",
      body: JSON.stringify({ ip, port }),
    });
    const data = await res.json();
    eqSetStatusPill(res.ok && data.connected ? "ready" : "error");
    eqPollStatus();
  });

  document.getElementById("eq-add-custom-btn").addEventListener("click", () => {
    const raw = document.getElementById("eq-custom-job").value.trim();
    const n = parseInt(raw, 10);
    if (Number.isNaN(n) || n < 0 || n > 1999) {
      alert("Enter a job number between 0 and 1999.");
      return;
    }
    eqAddJob(n);
    document.getElementById("eq-custom-job").value = "";
  });

  document.getElementById("eq-clear-queue-btn").addEventListener("click", async () => {
    await apiFetch("/api/equipment/queue", { method: "DELETE" });
    eqPollStatus();
  });

  document.getElementById("eq-raw-send-btn").addEventListener("click", async () => {
    const { ip, port } = eqGetIpPort();
    const command = document.getElementById("eq-raw-cmd").value.trim();
    if (!command) return;
    await apiFetch("/api/equipment/raw", {
      method: "POST",
      body: JSON.stringify({ ip, port, command }),
    });
    eqPollStatus();
  });

  document.getElementById("eq-cat-select").addEventListener("change", eqOnCategoryChange);
  document.getElementById("eq-cmd-select").addEventListener("change", eqOnCommandChange);
  document.getElementById("eq-mode-wx").addEventListener("click", () => eqSetMode("wx"));
  document.getElementById("eq-mode-rx").addEventListener("click", () => eqSetMode("rx"));

  document.getElementById("eq-run-cmd-btn").addEventListener("click", async () => {
    const { ip, port } = eqGetIpPort();
    const command = document.getElementById("eq-preview-box").textContent.trim();
    if (!command || command.startsWith("(invalid")) {
      alert("Invalid or empty command.");
      return;
    }
    await apiFetch("/api/equipment/raw", {
      method: "POST",
      body: JSON.stringify({ ip, port, command }),
    });
    eqPollStatus();
  });

  document.getElementById("eq-copy-raw-btn").addEventListener("click", () => {
    document.getElementById("eq-raw-cmd").value = document.getElementById("eq-preview-box").textContent.trim();
  });

  document.getElementById("eq-clear-log-btn").addEventListener("click", () => {
    document.getElementById("eq-log").innerHTML = "";
  });

  eqPollStatus();
  EQ.pollTimer = setInterval(eqPollStatus, 1500);
};

PAGE_TEARDOWN.equipment = function () {
  if (EQ.pollTimer) clearInterval(EQ.pollTimer);
  EQ.pollTimer = null;
};

/* ============================================================
   FOR USER PAGE (admin only)
   ============================================================ */
async function userFetchAndRender(filter) {
  const tbody = document.getElementById("user-table-body");
  tbody.innerHTML = `<tr><td colspan="7" class="eq-queue-empty">Loading…</td></tr>`;
  const qs = filter ? `?status=${filter}` : "";
  const res = await apiFetch(`/api/users${qs}`);
  const users = await res.json();

  if (users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="eq-queue-empty">No users found.</td></tr>`;
    return;
  }

  tbody.innerHTML = users
    .map((u) => {
      const avatar = u.photo_path
        ? `<img class="avatar-sm" src="${u.photo_path}" />`
        : `<img class="avatar-sm" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3C/svg%3E" />`;
      const actions = [];
      if (u.status === "pending") {
        actions.push(`<button class="btn btn-sm" onclick="userSetStatus(${u.id},'approved')">Approve</button>`);
        actions.push(`<button class="btn btn-sm btn-danger" onclick="userSetStatus(${u.id},'rejected')">Reject</button>`);
      } else if (u.id !== CURRENT_USER.id) {
        const toggleRole = u.role === "admin" ? "user" : "admin";
        actions.push(`<button class="btn btn-sm" onclick="userSetRole(${u.id},'${toggleRole}')">Make ${toggleRole}</button>`);
      }
      return `
      <tr>
        <td>${avatar}</td>
        <td>${u.name}</td>
        <td class="mono">${u.employee_id}</td>
        <td><span class="tag ${u.role}">${u.role}</span></td>
        <td><span class="tag ${u.status}">${u.status}</span></td>
        <td>${new Date(u.created_at).toLocaleDateString()}</td>
        <td style="display:flex;gap:6px;">${actions.join("")}</td>
      </tr>`;
    })
    .join("");
}

async function userSetStatus(id, status) {
  await apiFetch(`/api/users/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
  const activeFilter = document.querySelector(".user-filter-bar button.active");
  userFetchAndRender(activeFilter ? activeFilter.dataset.filter : "pending");
}
window.userSetStatus = userSetStatus;

async function userSetRole(id, role) {
  await apiFetch(`/api/users/${id}/role`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
  const activeFilter = document.querySelector(".user-filter-bar button.active");
  userFetchAndRender(activeFilter ? activeFilter.dataset.filter : "pending");
}
window.userSetRole = userSetRole;

PAGE_INIT.all_user = function () {
  document.querySelectorAll(".user-filter-bar button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".user-filter-bar button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      userFetchAndRender(btn.dataset.filter);
    });
  });
  userFetchAndRender("pending");
};

/* ============================================================
   FOR PROFILE PAGE
   ============================================================ */
PAGE_INIT.profile = function () {
  document.getElementById("pf-name").textContent = CURRENT_USER.name;
  document.getElementById("pf-employee-id").textContent = CURRENT_USER.employee_id;
  document.getElementById("pf-name-input").value = CURRENT_USER.name;
  if (CURRENT_USER.photo_path) {
    document.getElementById("pf-avatar").src = CURRENT_USER.photo_path;
  }

  document.getElementById("pf-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const alertBox = document.getElementById("pf-alert-box");
    alertBox.innerHTML = "";

    const fd = new FormData();
    const name = document.getElementById("pf-name-input").value.trim();
    const password = document.getElementById("pf-password-input").value;
    const photoFile = document.getElementById("pf-photo").files[0];
    if (name) fd.append("name", name);
    if (password) fd.append("password", password);
    if (photoFile) fd.append("photo", photoFile);

    const res = await apiFetch("/api/auth/profile", { method: "PUT", body: fd });
    const data = await res.json();
    if (!res.ok) {
      alertBox.innerHTML = `<div class="alert alert-error">${data.error || "Update failed."}</div>`;
      return;
    }
    applyUserToChrome(data);
    localStorage.setItem("nlm_user", JSON.stringify(data));
    alertBox.innerHTML = `<div class="alert alert-success">Profile updated.</div>`;
    document.getElementById("pf-name").textContent = data.name;
    document.getElementById("pf-password-input").value = "";
  });
};
