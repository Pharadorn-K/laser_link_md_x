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

/* ============================================================
   TOP BAR CLOCK — DD/MM/YYYY HH:MM:SS, ticks every second
   ============================================================ */
function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatTopbarClock(d) {
  const dd = pad2(d.getDate());
  const mm = pad2(d.getMonth() + 1);
  const yyyy = d.getFullYear();
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}`;
}

let topbarClockTimer = null;
function startTopbarClock() {
  const el = document.getElementById("topbar-clock");
  if (!el) return;
  const tick = () => { el.textContent = formatTopbarClock(new Date()); };
  tick();
  clearInterval(topbarClockTimer);
  topbarClockTimer = setInterval(tick, 1000);
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
  add_new_model: "Add New Model",
  alarm_center: "Alarm Center",
  profile: "Profile",
  all_user: "Users",
};

// Per-page init hooks, filled in by each section below.
const PAGE_INIT = {};
// Per-page teardown hooks (e.g. stop polling) when navigating away.
const PAGE_TEARDOWN = {};

let activePage = null;

const PAGE_ROLES = {
  model_setting: ["admin", "engineer", "machine_controller"],
  add_new_model: ["admin", "engineer"],
  all_user: ["admin"],
};

async function loadPage(page) {
  const allowedRoles = PAGE_ROLES[page];
  if (allowedRoles && (!CURRENT_USER || !allowedRoles.includes(CURRENT_USER.role))) return;

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
  startTopbarClock();
  initLightbox(); // NEW
}

function applyUserToChrome(user) {
  CURRENT_USER = user;
  document.getElementById("topbar-username").textContent = user.name;
  document.getElementById("topbar-role").textContent = user.role.toUpperCase();
  if (user.photo_path) {
    document.getElementById("topbar-avatar").src = user.photo_path;
  }
  document.querySelectorAll("[data-roles]").forEach((el) => {
    const allowed = el.dataset.roles.split(",").map((r) => r.trim());
    el.style.display = allowed.includes(user.role) ? "" : "none";
  });
}

/* ============================================================
   PHOTO LIGHTBOX — click any pallet/profile photo to view full size
   ============================================================ */
const PHOTO_CLICK_SELECTOR =
  ".ms-pallet-photo-frame img, .mon-photo-frame img, #pf-avatar, #ms-f-photo-preview";

function isPlaceholderImg(src) {
  return !src || src.startsWith("data:image/svg+xml");
}

function openLightbox(src, alt) {
  const backdrop = document.getElementById("lightbox-backdrop");
  const img = document.getElementById("lightbox-img");
  if (!backdrop || !img) return;
  img.src = src;
  img.alt = alt || "";
  backdrop.classList.add("open");
}

function closeLightbox() {
  const backdrop = document.getElementById("lightbox-backdrop");
  const img = document.getElementById("lightbox-img");
  if (backdrop) backdrop.classList.remove("open");
  if (img) img.src = "";
}

function initLightbox() {
  document.addEventListener("click", (e) => {
    const img = e.target.closest(PHOTO_CLICK_SELECTOR);
    if (img && img.tagName === "IMG" && !isPlaceholderImg(img.src)) {
      openLightbox(img.src, img.alt);
    }
  });

  const backdrop = document.getElementById("lightbox-backdrop");
  const closeBtn = document.getElementById("lightbox-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", closeLightbox);
  if (backdrop) {
    backdrop.addEventListener("click", (e) => {
      if (e.target.id === "lightbox-backdrop") closeLightbox();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
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

// Shared by both MANUAL (WM_START_SEQUENCE) and AUTO (AUTO_SEQUENCE_STEPS /
// AUTO_SINGLE_LOOP_STEPS) sequences: stamps a `.skipped` flag onto each step
// based on the currently selected model's check_* flags. job may be null
// (no model selected yet) — skipIf always guards with `!!job &&`, so nothing
// is marked skipped until a real model is selected.
function applySkipFlags(steps, job) {
  return steps.map((s) => ({
    ...s,
    skipped: typeof s.skipIf === "function" ? !!s.skipIf(job) : false,
  }));
}
// Builds the base command string for a model_condition row, e.g.
// "JobNo=0001,BLK=001,CharacterString=G,BLK=002,CharacterString=K9L"
function buildBaseCommand(condition) {
  if (!condition) return "";
  const parts = [`JobNo=${padJob(condition.job_no)}`];
  // if (condition.check_lot_no && condition.lot_no_block !== null && condition.lot_no_block !== undefined && condition.lot_no) {
  //   parts.push(`BLK=${padBlk(condition.lot_no_block)}`);
  //   parts.push(`CharacterString=${condition.lot_no}`);
  // }
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

/* ---- Check-result status (Camera / 2D Read / 2D Grade) per pallet ----
   Simulated for now — no equipment signal wired up yet. Persisted so
   Monitor reflects the latest result even if the sequence that produced
   it ran on the Model Setting page (manual mode). ---- */
function getCheckStatus(pallet) {
  try {
    const all = JSON.parse(localStorage.getItem("nlm_check_status") || "{}");
    return all[pallet] || null;
  } catch (err) {
    return null;
  }
}

function setCheckStatus(pallet, status) {
  let all;
  try {
    all = JSON.parse(localStorage.getItem("nlm_check_status") || "{}");
  } catch (err) {
    all = {};
  }
  if (status) all[pallet] = status;
  else delete all[pallet];
  localStorage.setItem("nlm_check_status", JSON.stringify(all));
}

// Resets a pallet's status block to reflect the currently selected job:
// "Skipped" for any check disabled on that job, "—" (pending) otherwise.
// Call this whenever a new cycle starts, so stale results don't linger.
function monInitCheckStatusForJob(pallet, job) {
  const status = {
    jobId: job ? job.id : null,
    camera: job && !job.check_camera ? "Skipped" : "—",
    code2dRead: job && !job.check_read2dcode ? "Skipped" : "—",
    code2dGrade: job && !job.check_grade2dcode ? "Skipped" : "—",
  };
  setCheckStatus(pallet, status);
  return status;
}

// Used by render: reuse the stored status if it still belongs to the
// same job, otherwise (job changed, or nothing stored yet) reinit it.
function monGetOrInitCheckStatus(pallet, job) {
  const existing = getCheckStatus(pallet);
  if (!job) {
    setCheckStatus(pallet, null);
    return { camera: "—", code2dRead: "—", code2dGrade: "—" };
  }
  if (existing && existing.jobId === job.id) return existing;
  return monInitCheckStatusForJob(pallet, job);
}

function monStatusClass(value) {
  if (value === "Correct" || value === "Pass" || value === "OK") return "good";
  if (value === "Skipped") return "skip";
  if (value === "—") return "pending";
  return "bad"; // Incorrect / Not Pass / Error / R / S / T
}

// Updates the stored value AND the live DOM (if the Monitor page's
// pallet block happens to be mounted right now).
function monSetCheckStatus(pallet, field, value) {
  const current = getCheckStatus(pallet) || {};
  current[field] = value;
  setCheckStatus(pallet, current);

  const idMap = { camera: "camera", code2dRead: "code2dread", code2dGrade: "code2dgrade" };
  const el = document.getElementById(`mon-chk-${idMap[field]}-${pallet}`);
  if (!el) return;
  el.textContent = value;
  el.className = `mon-chkval mon-chkval-${monStatusClass(value)}`;
}

// Maps a sequence step's id to the field it should update, and derives
// the simulated result value. `ok` is the step's success/failure.
function monApplyStepResult(pallet, step, ok) {
  const fieldByStepId = {
    camera_check: "camera",
    code_result: "code2dRead",
    code_grade: "code2dGrade",
  };
  const field = fieldByStepId[step.id];
  if (!field) return;

  let value;
  if (step.skipped) {
    value = "Skipped";
  } else if (!ok) {
    value = "Error";
  } else if (field === "camera") {
    value = "Correct";
  } else if (field === "code2dRead") {
    value = "OK";
  } else {
    value = "Pass";
  }
  monSetCheckStatus(pallet, field, value);
}

/* ============================================================
   FOR MONITOR PAGE
   ============================================================
   NOTE: no equipment backend yet (hardware pending), so:
   - "2 push buttons start" is a Simulate button (mon-simulate-btn)
   - "marking complete" (the count-part trick) is simulated at the
     end of the sequence for whichever pallet is running
   Swap mon Simulate/step logic for a real signal (websocket or
   polling /api/equipment/status) once the Python service reports
   these events; monReportCount() is the one place that should
   call POST /api/production/log for real.
   ============================================================ */
const MON_STEPS = [
  { id: "open_door",  label: "Open door" },
  { id: "close_door", label: "Close door" },
  { id: "check_cam",  label: "Check camera" },
  { id: "start_mark", label: "Start marking" },
  { id: "count_part", label: "Count part / log result" },
];

const MON = {
  counts: { Pallet1: 0, Pallet2: 0 },
  lastMarked: { Pallet1: null, Pallet2: null },
  running: false,
  timer: null,
  mode: null, // snapshot of work-mode at page load
};

const MON_AUTO = {
  queue: 0,
  running: false,
  roundCount: { Pallet1: 0, Pallet2: 0 },
  palletCycleIndex: 0,
};

function monIsAutoMode(mode) {
  return mode === "AUTO1-2" || mode === "AUTO1" || mode === "AUTO2";
}

function monAutoActivePallets(mode) {
  if (mode === "AUTO1") return ["Pallet1"];
  if (mode === "AUTO2") return ["Pallet2"];
  return ["Pallet1", "Pallet2"];
}

function monAutoNextPallet(mode) {
  const pallets = monAutoActivePallets(mode);
  if (pallets.length === 1) return pallets[0];
  const p = pallets[MON_AUTO.palletCycleIndex % pallets.length];
  MON_AUTO.palletCycleIndex += 1;
  return p;
}

// Same lookup as monAutoNextPallet but read-only — used to preview which
// pallet/model the *next* cycle will run against, without consuming a turn.
function monPeekNextAutoPallet(mode) {
  const pallets = monAutoActivePallets(mode);
  if (pallets.length === 1) return pallets[0];
  return pallets[MON_AUTO.palletCycleIndex % pallets.length];
}

// Animates step state (pending/active/done) directly on the already-visible
// First Cycle / Loop Cycle lists built by monRenderSeqPreview(), instead of
// swapping to a separate flat list. activeIndex === steps.length -> all done.
function monSetPreviewStepState(listId, steps, activeIndex) {
  const list = document.getElementById(listId);
  if (!list) return;
  const items = list.querySelectorAll("li");
  items.forEach((li, i) => {
    li.classList.remove("pending", "active", "done", "skipped");
    const skipped = steps[i] && steps[i].skipped;
    if (skipped && i <= activeIndex) {
      li.classList.add("skipped");
    } else if (i < activeIndex) {
      li.classList.add("done");
    } else if (i === activeIndex) {
      li.classList.add(skipped ? "skipped" : "active");
    } else {
      li.classList.add("pending");
    }
  });
}

function monResetPreviewStepState(listId, steps) {
  monSetPreviewStepState(listId, steps, -1);
}

function monRenderSeqPreviewList(elId, steps, round) {
  const list = document.getElementById(elId);
  if (!list) return;
  list.innerHTML = steps.map((s, i) => {
    const label = s.firstLabel ? (round === "first" ? s.firstLabel : s.loopLabel) : s.label;
    const tooltip = wmTooltipText({ ...s, label }) + (s.skipped ? " — Skipped (not required for this model)" : "");
    const skipTag = s.skipped ? ` <span class="wm-seq-skip-tag">(skipped)</span>` : "";
    return `<li class="wm-seq-step pending" title="${escapeHtml(tooltip)}"><span class="wm-seq-num">${i + 1}</span>${label}${skipTag}</li>`;
  }).join("");
}

function monRenderSeqPreview(mode) {
  const wrap = document.getElementById("mon-seq-preview");
  if (!wrap) return;
  const info = wmAutoModeInfo(mode);

  if (info.kind === "single") {
    const job = getSelectedJob(info.pallet);
    const steps = applySkipFlags(AUTO_SINGLE_LOOP_STEPS, job);
    wrap.innerHTML = `
      <div class="card-title" style="margin-top:0;">Loop Cycle <span style="font-weight:400;color:var(--ink-faint);font-size:11px;">(repeats every 2-hand start)</span></div>
      <ol class="wm-seq-list" id="mon-preview-loop-list"></ol>`;
    monRenderSeqPreviewList("mon-preview-loop-list", steps);
  } else {
    const nextPallet = monPeekNextAutoPallet(mode);
    const job = getSelectedJob(nextPallet);
    const steps = applySkipFlags(AUTO_SEQUENCE_STEPS, job);
    wrap.innerHTML = `
      <div class="wm-auto-seq-cols">
        <div class="wm-auto-seq-col">
          <div class="card-title" style="margin-top:0;">First Cycle <span style="font-weight:400;color:var(--ink-faint);font-size:11px;">(on the first 2-hand start)</span></div>
          <ol class="wm-seq-list" id="mon-preview-first-list"></ol>
        </div>
        <div class="wm-auto-seq-col">
          <div class="card-title" style="margin-top:0;">Loop Cycle <span style="font-weight:400;color:var(--ink-faint);font-size:11px;">(after every following start)</span></div>
          <ol class="wm-seq-list" id="mon-preview-loop-list"></ol>
        </div>
      </div>`;
    monRenderSeqPreviewList("mon-preview-first-list", steps, "first");
    monRenderSeqPreviewList("mon-preview-loop-list", steps, "loop");
  }
}

function monShowPreview() {
  const preview = document.getElementById("mon-seq-preview");
  const idle = document.getElementById("mon-seq-idle");
  const list = document.getElementById("mon-seq-list");
  if (preview) preview.style.display = "";
  if (idle) idle.style.display = "none";
  if (list) list.style.display = "none";
}

function monShowLiveList() {
  const preview = document.getElementById("mon-seq-preview");
  const idle = document.getElementById("mon-seq-idle");
  const list = document.getElementById("mon-seq-list");
  if (preview) preview.style.display = "none";
  if (idle) idle.style.display = "none";
  if (list) list.style.display = "";
}

async function monAutoRunOneCycle(mode) {
  const info = wmAutoModeInfo(mode);
  monShowPreview(); // keep the First/Loop columns visible the whole run

  if (info.kind === "single") {
    const pallet = info.pallet;
    MON.activePallet = pallet;

    const job = getSelectedJob(pallet);
    monInitCheckStatusForJob(pallet, job); // reset to pending/skipped for this cycle
    monRenderPalletBlock(pallet);

    const steps = applySkipFlags(AUTO_SINGLE_LOOP_STEPS, job);
    monRenderSeqPreviewList("mon-preview-loop-list", steps);
    monResetPreviewStepState("mon-preview-loop-list", steps);
    for (let i = 0; i < steps.length; i++) {
      monSetPreviewStepState("mon-preview-loop-list", steps, i);
      if (steps[i].skipped) {
        monApplyStepResult(pallet, steps[i], true);
        await new Promise((r) => setTimeout(r, 150)); // brief pause so the yellow state is visible
        continue;
      }
      try {
        await steps[i].fn();
        monApplyStepResult(pallet, steps[i], true);
      } catch (err) {
        monApplyStepResult(pallet, steps[i], false);
        showToast(`Auto cycle error: ${err}`);
        break;
      }
    }
    monSetPreviewStepState("mon-preview-loop-list", steps, steps.length);

    if (job) monReportCount(pallet, job);
    return;
  }

  const pallet = monAutoNextPallet(mode);
  const round = MON_AUTO.roundCount[pallet] === 0 ? "first" : "loop";
  const activeListId = round === "first" ? "mon-preview-first-list" : "mon-preview-loop-list";
  MON.activePallet = pallet;

  const job = getSelectedJob(pallet);
  monInitCheckStatusForJob(pallet, job); // reset to pending/skipped for this cycle
  monRenderPalletBlock(pallet);

  const steps = applySkipFlags(AUTO_SEQUENCE_STEPS, job);
  monRenderSeqPreviewList(activeListId, steps, round);
  monResetPreviewStepState(activeListId, steps);
  for (let i = 0; i < steps.length; i++) {
    monSetPreviewStepState(activeListId, steps, i);
    if (steps[i].skipped) {
      monApplyStepResult(pallet, steps[i], true);
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    try {
      await steps[i].fn(round);
      monApplyStepResult(pallet, steps[i], true);
    } catch (err) {
      monApplyStepResult(pallet, steps[i], false);
      showToast(`Auto cycle error: ${err}`);
      break;
    }
  }
  monSetPreviewStepState(activeListId, steps, steps.length);
  MON_AUTO.roundCount[pallet] += 1;

  if (job) monReportCount(pallet, job);
}

async function monProcessAutoQueue(mode) {
  if (MON_AUTO.running) return;
  MON_AUTO.running = true;
  MON.running = true;
  document.getElementById("mon-signal-pill").className = "status-pill busy";
  document.getElementById("mon-signal-pill").innerHTML = '<span class="dot"></span> Signal received';

  while (MON_AUTO.queue > 0) {
    MON_AUTO.queue -= 1;
    await monAutoRunOneCycle(mode);
  }

  MON_AUTO.running = false;
  MON.running = false;
  MON.activePallet = null;
  document.getElementById("mon-signal-pill").className = "status-pill offline";
  document.getElementById("mon-signal-pill").innerHTML = '<span class="dot"></span> Waiting for signal';
  monShowPreview();
  monRenderAll();
}

function monHandleStartSignal() {
  const mode = wmLoadMode();
  if (!monIsAutoMode(mode)) {
    showToast("Manual mode is active — start marking from the Work Mode page.", "info");
    return;
  }

  const info = wmAutoModeInfo(mode);
  const pallets = info.kind === "single" ? [info.pallet] : monAutoActivePallets(mode);
  const ready = pallets.filter((p) => !!getSelectedJob(p));
  if (ready.length === 0) {
    showToast(`Select a model for ${info.kind === "single" ? info.pallet : "the active pallet(s)"} on Model Setting first.`);
    return;
  }

  MON_AUTO.queue += 1;
  showToast(MON_AUTO.running ? "Cycle queued — runs after the current one." : "2-hand start received — running cycle…", "info");
  monProcessAutoQueue(mode);
}

function monActivePallets() {
  return ["Pallet1", "Pallet2"].filter((p) => !!getSelectedJob(p));
}

// ---- condition / check summary chips, shared with the pallet card ----
// Editable condition/lot-no rows for the Monitor pallet card — same
// concept as Model Setting's ms-cond-edit-list, so operators can update
// values (e.g. every ≤150 pcs) without leaving Monitor.
function monConditionEditRowsHtml(job, pallet) {
  const items = job.conditions || [];

  const cameraRow = `
    <div class="ms-cond-edit-row mon-cond-edit-row ms-camera-row" data-pallet="${pallet}">
      <div class="ms-cond-edit-meta">
        <span class="ms-cond-edit-name">Camera Check</span>
        <span class="ms-cond-edit-blk mono">${job.check_camera ? "Enabled" : "Disabled — bypassed"}</span>
      </div>
      <button type="button" class="btn btn-sm ${job.check_camera ? "btn-danger" : "btn-primary"} mon-camera-toggle-btn" data-current="${job.check_camera ? "1" : "0"}">
        ${job.check_camera ? "Turn OFF" : "Turn ON"}
      </button>
    </div>`;

  const lotRow = job.check_lot_no
    ? `<div class="ms-cond-edit-row mon-cond-edit-row ms-lotno-row" data-pallet="${pallet}">
        <div class="ms-cond-edit-meta">
          <span class="ms-cond-edit-name">Lot No.</span>
          <span class="ms-cond-edit-blk mono">Not marked</span>
        </div>
        <input type="text" class="ms-cond-edit-input mon-lotno-input" value="${escapeHtml(job.lot_no || "")}" />
        <button type="button" class="btn btn-sm btn-primary mon-lotno-set-btn">Set</button>
      </div>`
    : "";

  const condRows = items.length
    ? items.map((it) => `
      <div class="ms-cond-edit-row mon-cond-edit-row" data-item-id="${it.id}" data-pallet="${pallet}">
        <div class="ms-cond-edit-meta">
          <span class="ms-cond-edit-name">${escapeHtml(it.condition_name)}</span>
          <span class="ms-cond-edit-blk mono">BLK ${padBlk(it.block_no)}</span>
        </div>
        <input type="text" class="ms-cond-edit-input mon-cond-input" value="${escapeHtml(it.condition_value)}" />
        <button type="button" class="btn btn-sm btn-primary mon-cond-set-btn">Set</button>
      </div>`).join("")
    : `<div class="eq-queue-empty">No conditions set.</div>`;

  return cameraRow + lotRow + condRows;
}

function monCheckBadgesHtml(job) {
  const checks = [
    ["Start 2D", job.check_start2dcode],
    ["Read 2D", job.check_read2dcode],
    ["Grade 2D", job.check_grade2dcode],
    ["Camera", job.check_camera],
  ];
  return checks
    .map(([label, on]) => `<span class="mon-chk-badge ${on ? "on" : "off"}">${on ? "✓" : "✕"} ${label}</span>`)
    .join("");
}

function monRenderPalletBlock(pallet) {
  const job = getSelectedJob(pallet);
  const lock = document.getElementById(`mon-lock-${pallet}`);
  const body = document.getElementById(`mon-body-${pallet}`);

  if (!job) {
    lock.classList.add("show");
    body.innerHTML = "";
    setCheckStatus(pallet, null);
    return;
  }
  lock.classList.remove("show");

  const running = MON.running && MON.activePallet === pallet;
  const statusClass = running ? "busy" : "ready";
  const statusLabel = running ? "Running" : "Idle";
  const lastMarked = MON.lastMarked[pallet];
  const checkStatus = monGetOrInitCheckStatus(pallet, job);

  const photoHtml = job.photo_path
    ? `<img src="${job.photo_path}" alt="${escapeHtml(job.model)}" />`
    : `<div class="ms-photo-placeholder"><i class="fa-regular fa-image"></i><span>No photo</span></div>`;

  const chkRow = (label, field, idSuffix) => `
    <div class="mon-chk-item">
      <span class="mon-chk-label">${label}</span>
      <span class="mon-chkval mon-chkval-${monStatusClass(checkStatus[field])}" id="mon-chk-${idSuffix}-${pallet}">${escapeHtml(checkStatus[field])}</span>
    </div>`;

  body.innerHTML = `
    <div class="mon-model-row">
      <div>
        <div class="mon-model-name">${escapeHtml(job.model)}</div>
        <div class="mon-model-meta mono">Job ${padJob(job.job_no)}${job.control_grade ? ` · Grade ${escapeHtml(job.control_grade)}` : ""}</div>
      </div>
      <span class="status-pill ${statusClass}"><span class="dot"></span> ${statusLabel}</span>
    </div>

    <div class="mon-detail-layout">
      <div class="mon-photo-frame">${photoHtml}</div>
      <div class="mon-detail-info">
        <div class="mon-chk-row">${monCheckBadgesHtml(job)}</div>
        <div class="ms-cond-edit-list mon-cond-edit-list">${monConditionEditRowsHtml(job, pallet)}</div>
      </div>
    </div>

    <div class="mon-count-block">
      <div class="mon-count-col mon-checks-col">
        <div class="mon-count-label">Check Results</div>
        <div class="mon-chk-list">
          ${chkRow("Camera Check", "camera", "camera")}
          ${chkRow("2D Code Read", "code2dRead", "code2dread")}
          ${chkRow("2D Code Grade", "code2dGrade", "code2dgrade")}
        </div>
      </div>
      <div class="mon-count-col mon-count-num-col">
        <div class="mon-count-label">Count Part</div>
        <div class="mon-count-value" id="mon-count-${pallet}">${MON.counts[pallet]}</div>
        <div class="mon-count-sub">${lastMarked ? `Last: ${new Date(lastMarked).toLocaleTimeString()}` : "No parts marked yet"}</div>
      </div>
    </div>

    <div class="mon-dev-row">
      <button class="btn btn-sm btn-ghost" data-reset="${pallet}">Reset count</button>
    </div>
  `;

  body.querySelector(`[data-reset="${pallet}"]`).addEventListener("click", () => {
    MON.counts[pallet] = 0;
    monRenderPalletBlock(pallet);
  });

  body.querySelectorAll(".mon-cond-set-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".mon-cond-edit-row");
      const itemId = row.dataset.itemId;
      const input = row.querySelector(".mon-cond-input");
      const item = (job.conditions || []).find((i) => String(i.id) === String(itemId));
      const newValue = input.value.trim();
      if (!newValue) { showToast("Value cannot be empty."); return; }
      if (newValue === item.condition_value) { showToast("No change.", "info"); return; }

      MON.pendingSet = { pallet, modelId: job.id, itemId, newValue, oldValue: item.condition_value, name: item.condition_name };
      document.getElementById("mon-confirm-text").textContent =
        `Change "${item.condition_name}" from "${item.condition_value}" to "${newValue}"?`;
      document.getElementById("mon-confirm-backdrop").classList.add("open");
    });
  });

  const lotBtn = body.querySelector(".mon-lotno-set-btn");
  if (lotBtn) {
    lotBtn.addEventListener("click", () => {
      const input = body.querySelector(".mon-lotno-input");
      const newValue = input.value.trim();
      if (!newValue) { showToast("Lot No. cannot be empty."); return; }
      if (newValue === job.lot_no) { showToast("No change.", "info"); return; }

      MON.pendingSet = { pallet, modelId: job.id, itemId: null, newValue, oldValue: job.lot_no, name: "Lot No.", isLotNo: true };
      document.getElementById("mon-confirm-text").textContent =
        `Change "Lot No." from "${job.lot_no || "(empty)"}" to "${newValue}"? This is only logged with each part counted — it isn't marked on the workpiece.`;
      document.getElementById("mon-confirm-backdrop").classList.add("open");
    });
  }

  const cameraBtn = body.querySelector(".mon-camera-toggle-btn");
  if (cameraBtn) {
    cameraBtn.addEventListener("click", () => {
      const newValue = cameraBtn.dataset.current !== "1"; // toggle
      MON.pendingSet = { pallet, modelId: job.id, itemId: null, newValue, oldValue: job.check_camera, name: "Camera Check", isCamera: true };
      document.getElementById("mon-confirm-text").textContent = newValue
        ? "Re-enable Camera Check for this pallet?"
        : "Disable Camera Check for this pallet? Marking will proceed without a camera check until an Engineer re-enables it.";
      document.getElementById("mon-confirm-backdrop").classList.add("open");
    });
  }
}

function monRenderAll() {
  monRenderPalletBlock("Pallet1");
  monRenderPalletBlock("Pallet2");
}

function monRenderSeqList(steps, activeIndex, palletTag) {
  const idle = document.getElementById("mon-seq-idle");
  const list = document.getElementById("mon-seq-list");
  idle.style.display = "none";
  list.style.display = "";
  list.innerHTML = steps
    .map((s, i) => {
      let cls = "pending";
      if (i < activeIndex) cls = "done";
      else if (i === activeIndex) cls = "active";
      return `<li class="wm-seq-step ${cls}"><span class="wm-seq-num">${i + 1}</span>[${palletTag}] ${s.label}</li>`;
    })
    .join("");
}

function monReportCount(pallet, job) {
  MON.counts[pallet] += 1;
  MON.lastMarked[pallet] = new Date().toISOString();
  monRenderPalletBlock(pallet);
}

async function monRefetchJob(pallet) {
  const current = getSelectedJob(pallet);
  if (!current) return;
  try {
    const res = await apiFetch(`/api/models/${current.id}`);
    if (!res.ok) return;
    const updated = await res.json();
    setSelectedJob(pallet, updated);
    monRenderPalletBlock(pallet);
  } catch (err) {
    // stay on stale data; next render/poll will retry
  }
}

async function monConfirmSetValue() {
  const p = MON.pendingSet;
  document.getElementById("mon-confirm-backdrop").classList.remove("open");
  if (!p) return;
  try {
    const url = p.isCamera
      ? `/api/models/${p.modelId}/camera`
      : p.isLotNo
      ? `/api/models/${p.modelId}/lotno`
      : `/api/models/${p.modelId}/conditions/${p.itemId}`;
    const body = p.isCamera
      ? { check_camera: p.newValue }
      : p.isLotNo
      ? { lot_no: p.newValue }
      : { condition_value: p.newValue };
    const res = await apiFetch(url, { method: "PATCH", body: JSON.stringify(body) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || "Update failed.");
      return;
    }
    showToast(`"${p.name}" updated.`, "success");
    await monRefetchJob(p.pallet);
  } catch (err) {
    showToast("Could not reach the server.");
  } finally {
    MON.pendingSet = null;
  }
}

function monRunSequenceForPallet(pallet, onDone) {
  const job = getSelectedJob(pallet);
  let idx = 0;
  MON.activePallet = pallet;
  monRenderPalletBlock(pallet);

  const stepDelayMs = 700;
  const tick = () => {
    if (!MON.running) return;
    monRenderSeqList(MON_STEPS, idx, pallet);
    if (idx >= MON_STEPS.length) {
      if (job) monReportCount(pallet, job);
      onDone();
      return;
    }
    MON.timer = setTimeout(() => {
      idx += 1;
      tick();
    }, stepDelayMs);
  };
  tick();
}

function monApplyModeView() {
  const mode = wmLoadMode();
  MON.mode = mode;
  const isAuto = monIsAutoMode(mode);

  const banner = document.getElementById("mon-mode-banner");
  if (mode) {
    banner.className = `mon-mode-banner ${isAuto ? "auto" : "manual"}`;
    banner.innerHTML = `<i class="fa-solid ${isAuto ? "fa-gears" : "fa-hand"}"></i> Current mode: <strong>${mode}</strong>${isAuto ? "" : " — set an AUTO mode on Model Setting to run the live sequence here."}`;
  } else {
    banner.className = "mon-mode-banner none";
    banner.innerHTML = `<i class="fa-solid fa-circle-question"></i> No mode set yet — go to <strong>Model Setting</strong> to choose MANUAL or an AUTO mode.`;
  }

  document.getElementById("mon-auto-block").style.display = isAuto ? "" : "none";
  document.getElementById("mon-manual-block").style.display = isAuto ? "none" : "";
  document.getElementById("mon-seq-title").textContent = isAuto ? "Live Sequence" : "Manual Mode";

  if (isAuto) {
    monRenderSeqPreview(mode);
    monShowPreview();
  }
}

PAGE_INIT.monitor = function () {
  MON.running = false;
  MON.activePallet = null;
  MON.pendingSet = null;
  monRenderAll();
  monApplyModeView();

  document.getElementById("mon-simulate-btn").addEventListener("click", monHandleStartSignal);
  const gotoBtn = document.getElementById("mon-goto-modelsetting-btn");
  if (gotoBtn) gotoBtn.addEventListener("click", () => loadPage("model_setting"));

  document.getElementById("mon-confirm-yes-btn").addEventListener("click", monConfirmSetValue);
  document.getElementById("mon-confirm-no-btn").addEventListener("click", () => {
    document.getElementById("mon-confirm-backdrop").classList.remove("open");
    MON.pendingSet = null;
  });
  document.getElementById("mon-confirm-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "mon-confirm-backdrop") {
      document.getElementById("mon-confirm-backdrop").classList.remove("open");
      MON.pendingSet = null;
    }
  });
};

PAGE_TEARDOWN.monitor = function () {
  MON.running = false;
  MON_AUTO.running = false;
  clearTimeout(MON.timer);
};

/* ============================================================
   FOR WORK MODE PAGE
   ============================================================ */
const WM_MODE_KEY = "nlm_work_mode";

const WM = {
  mode: null,       // "MANUAL" | "AUTO1-2" | "AUTO1" | "AUTO2" | null
  manualRunning: false,
  runningPallet: null,
  seqRunning: false,
  seqTimer: null,
  seqIndex: -1,
};

// In-memory ONLY — intentionally not persisted to localStorage or the
// backend. This is a UI convenience so the two Start Marking buttons
// reflect "who's currently in the Operator Room" during this session.
// Any function that needs to make a REAL decision about equipment state
// must read the live sensor/signal at that moment — this value is never
// a substitute for that, and it resets on every full page reload.
const WM_PALLET_STATE = {
  operatorRoomPallet: "Pallet1", // default — no real signal wired up yet
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

function wmCheckPalletsReady(mode) {
  const info = wmAutoModeInfo(mode);
  const pallets = info.kind === "single" ? [info.pallet] : monAutoActivePallets(mode);
  const missing = pallets.filter((p) => !getSelectedJob(p));
  return { ok: missing.length === 0, missing };
}

function wmApplyMode(mode) {
  WM.mode = mode;
  wmSaveMode(mode);

  const pill = document.getElementById("wm-active-mode-pill");
  if (pill) {
    pill.textContent = mode ? `Active: ${mode}` : "No mode active";
    pill.classList.toggle("set", !!mode);
  }

  const isManual = mode === "MANUAL";
  const isAuto = mode === "AUTO1-2" || mode === "AUTO1" || mode === "AUTO2";

  const contentWrap = document.getElementById("wm-mode-content");
  const emptyMsg = document.getElementById("wm-mode-empty");
  const manualBlock = document.getElementById("wm-manual-block");
  const autoBlock = document.getElementById("wm-auto-block");
  if (!contentWrap || !emptyMsg || !manualBlock || !autoBlock) return;

  if (!mode) {
    contentWrap.style.display = "none";
    emptyMsg.style.display = "";
    manualBlock.style.display = "none";
    autoBlock.style.display = "none";
    return;
  }

  contentWrap.style.display = "";
  emptyMsg.style.display = "none";
  manualBlock.style.display = isManual ? "" : "none";
  autoBlock.style.display = isAuto ? "" : "none";

  if (isAuto) {
    wmRenderPalletStatus();
    wmRenderAutoSequenceContent(mode);
  }
}

/* ============================================================
   Manual function registry — one entry per button from the spec.
   Every `run()` is a STUB today. When equipment is connected, only
   the body needs to change (call the real interlock check + the
   real equipment API) — the verdict shape below must stay the same
   so the sequence runner and every button keep working unmodified.

   Verdict contract:
     { ok: true,  message }                 — success, proceed
     { ok: false, alarm: true,  message }   — hard stop, raise alarm
     { ok: false, alarm: false, message }   — soft stop (e.g. interlock
                                               not satisfied yet)
   ============================================================ */
async function wmStub(name, ms = 500) {
  wmLog(`>>> ${name}`);
  await new Promise((r) => setTimeout(r, ms));
  wmLog(`<<< ${name}: OK (simulated)`, "ok");
  return { ok: true, message: `${name} OK (simulated)` };
}

const WM_FUNCTIONS = {
  OPEN_FRONT_DOOR: {
    label: "Open Front Door",
    group: "io",
    desc: "IAI EC-R6H-250-3-WA. Interlocks TBD: pallet not mid-travel, middle door state OK.",
    run: () => wmStub("OPEN_FRONT_DOOR"),
  },
  CLOSE_FRONT_DOOR: {
    label: "Close Front Door",
    group: "io",
    desc: "IAI EC-R6H-250-3-WA. Closes before pallet change or marking.",
    run: () => wmStub("CLOSE_FRONT_DOOR"),
  },
  CHANGE_PALLET: {
    label: "Change Pallet",
    group: "pallet",
    desc: "Swaps Pallet1/Pallet2 via the middle door. Interlocks TBD: front door closed, side door closed.",
    run: async () => {
      const result = await wmStub("CHANGE_PALLET", 900);
      WM_PALLET_STATE.operatorRoomPallet =
        WM_PALLET_STATE.operatorRoomPallet === "Pallet1" ? "Pallet2" : "Pallet1";
      wmUpdatePalletLocationUI();
      return result;
    },
  },
  CALL_PALLET1: {
    label: "Call Pallet 1",
    group: "pallet",
    desc: "IAI EC-S7H-500-3-WA #2 — bring Pallet 1 to the operator-side load position.",
    run: async () => {
      const result = await wmStub("CALL_PALLET1", 900);
      WM_PALLET_STATE.operatorRoomPallet = "Pallet1";
      wmUpdatePalletLocationUI();
      return result;
    },
  },
  CALL_PALLET2: {
    label: "Call Pallet 2",
    group: "pallet",
    desc: "IAI EC-S7H-500-3-WA #3 — bring Pallet 2 to the operator-side load position.",
    run: async () => {
      const result = await wmStub("CALL_PALLET2", 900);
      WM_PALLET_STATE.operatorRoomPallet = "Pallet2";
      wmUpdatePalletLocationUI();
      return result;
    },
  },
  CAMERA_TRIGGER: {
    label: "Camera Trigger",
    group: "vision",
    desc: "Fires the MD-X2520A camera check before marking.",
    run: () => wmStub("CAMERA_TRIGGER"),
  },
  CODE2D_START_READER: {
    label: "2D Code: Start Reader",
    group: "vision",
    desc: "WX,Check2DCode5 — starts 2D code verification on the marked part.",
    run: () => wmStub("2DCODE_START_READER"),
  },
  CODE2D_RESULT_READER: {
    label: "2D Code: Read Result",
    group: "vision",
    desc: "RX,CodeReadResult — reads back the last 2D code read result.",
    run: () => wmStub("2DCODE_RESULT_READER"),
  },
  CODE2D_GRADE_RESULT: {
    label: "2D Code: Grade Result",
    group: "vision",
    desc: "Reads the ISO grade of the last read, checked against Control Grade.",
    run: () => wmStub("2DCODE_GRADE_RESULT"),
  },
  START_MARKING: {
    label: "Start Marking",
    group: "laser",
    desc: "WX,StartMarking — triggers the laser on the currently selected job.",
    run: () => wmStub("START_MARKING", 1200),
  },
};

/* ------------------------------------------------------------
   Auto sequence template — the *first>>/*loop>> flow from spec.
   Same array drives: (a) the static preview on Work Mode, and
   (b) the live run on Monitor.
   ------------------------------------------------------------ */
const AUTO_SEQUENCE_STEPS = [
  {
    id: "cond_start",
    firstLabel: "Condition Start Loop",
    loopLabel: "Condition Start Auto",
    note: "D001 ON, D002 ON — 2-hand start pushed",
    fn: (round) => wmStub(round === "first" ? "CONDITION_START" : "CONDITION_START_AUTO", 200),
  },
  {
    id: "queue_loop",
    label: "Queue Loop Control",
    note: "Holds this cycle until the previous one confirms done",
    fn: () => wmStub("QUEUE_LOOP_CONTROL", 200),
  },
  { id: "close_front", label: "Close Front Door", fn: () => WM_FUNCTIONS.CLOSE_FRONT_DOOR.run() },
  { id: "camera_check", label: "Camera Check", fn: () => WM_FUNCTIONS.CAMERA_TRIGGER.run(),
    skipIf: (job) => !!job && !job.check_camera },
  { id: "change_pallet", label: "Change Pallet", fn: () => WM_FUNCTIONS.CHANGE_PALLET.run() },
  {
    id: "open_front",
    label: "Open Front Door",
    note: "Door reopens here — user can load/unload and push start again",
    fn: () => WM_FUNCTIONS.OPEN_FRONT_DOOR.run(),
  },
  { id: "start_marking", label: "Start Marking", fn: () => WM_FUNCTIONS.START_MARKING.run() },
  { id: "count_auto", label: "Count Part (Auto)", fn: () => wmStub("COUNT_AUTO", 300) },
  { id: "code_start", label: "2D Code: Start Reader", fn: () => WM_FUNCTIONS.CODE2D_START_READER.run(),
    skipIf: (job) => !!job && !job.check_start2dcode },
  { id: "code_result", label: "2D Code: Read Result", fn: () => WM_FUNCTIONS.CODE2D_RESULT_READER.run(),
    skipIf: (job) => !!job && !job.check_read2dcode },
  { id: "code_grade", label: "2D Code: Grade Result", fn: () => WM_FUNCTIONS.CODE2D_GRADE_RESULT.run(),
    skipIf: (job) => !!job && !job.check_grade2dcode },
  {
    id: "confirm_end",
    label: "Confirm End Loop",
    note: "Confirms Condition Start + Queue Loop Control actually completed",
    fn: () => wmStub("CONFIRM_END_LOOP", 200),
  },
];

/* ------------------------------------------------------------
   Single-pallet auto sequence (AUTO1 / AUTO2). Unlike AUTO1-2
   there's no first/loop split — the same loop repeats every
   time, and CHANGE_PALLET fires twice per cycle: once to bring
   the pallet into the machine room to mark, once to bring it
   back out to the operator room afterward.
   ------------------------------------------------------------ */
const AUTO_SINGLE_ACTIVATION_STEPS = (palletNum) => [
  { id: "close_front", label: "Close Front Door", fn: () => WM_FUNCTIONS.CLOSE_FRONT_DOOR.run() },
  {
    id: "call_pallet",
    label: `Call Pallet ${palletNum}`,
    note: "Checks pallet is in operator room; calls Change Pallet if not",
    fn: () => (palletNum === 1 ? WM_FUNCTIONS.CALL_PALLET1.run() : WM_FUNCTIONS.CALL_PALLET2.run()),
  },
  { id: "open_front", label: "Open Front Door", fn: () => WM_FUNCTIONS.OPEN_FRONT_DOOR.run() },
];

const AUTO_DUAL_ACTIVATION_STEPS = [
  { id: "open_front", label: "Open Front Door", fn: () => WM_FUNCTIONS.OPEN_FRONT_DOOR.run() },
];

const AUTO_SINGLE_LOOP_STEPS = [
  { id: "cond_start", label: "Condition Start", note: "D001 ON, D002 ON — 2-hand start pushed", fn: () => wmStub("CONDITION_START", 200) },
  { id: "queue_loop", label: "Queue Loop Control", note: "Holds this cycle until the previous one confirms done", fn: () => wmStub("QUEUE_LOOP_CONTROL", 200) },
  { id: "close_front", label: "Close Front Door", fn: () => WM_FUNCTIONS.CLOSE_FRONT_DOOR.run() },
  { id: "camera_check", label: "Camera Check", fn: () => WM_FUNCTIONS.CAMERA_TRIGGER.run(),
    skipIf: (job) => !!job && !job.check_camera },
  { id: "change_pallet_in", label: "Change Pallet (into machine room)", fn: () => WM_FUNCTIONS.CHANGE_PALLET.run() },
  { id: "start_marking", label: "Start Marking", fn: () => WM_FUNCTIONS.START_MARKING.run() },
  { id: "count_auto", label: "Count Part (Auto)", fn: () => wmStub("COUNT_AUTO", 300) },
  { id: "code_start", label: "2D Code: Start Reader", fn: () => WM_FUNCTIONS.CODE2D_START_READER.run(),
    skipIf: (job) => !!job && !job.check_start2dcode },
  { id: "code_result", label: "2D Code: Read Result", fn: () => WM_FUNCTIONS.CODE2D_RESULT_READER.run(),
    skipIf: (job) => !!job && !job.check_read2dcode },
  { id: "code_grade", label: "2D Code: Grade Result", fn: () => WM_FUNCTIONS.CODE2D_GRADE_RESULT.run(),
    skipIf: (job) => !!job && !job.check_grade2dcode },
  {
    id: "confirm_end",
    label: "Confirm End Loop",
    note: "Confirms Condition Start + Queue Loop Control actually completed",
    fn: () => wmStub("CONFIRM_END_LOOP", 200),
  },
  { id: "change_pallet_out", label: "Change Pallet", fn: () => WM_FUNCTIONS.CHANGE_PALLET.run() },
  { id: "open_front", label: "Open Front Door", fn: () => WM_FUNCTIONS.OPEN_FRONT_DOOR.run() },
];

function wmAutoModeInfo(mode) {
  if (mode === "AUTO1") return { kind: "single", pallet: "Pallet1", palletNum: 1 };
  if (mode === "AUTO2") return { kind: "single", pallet: "Pallet2", palletNum: 2 };
  return { kind: "dual" };
}

function wmTooltipText(step) {
  const parts = [];
  if (step.label) parts.push(step.label);
  if (step.note) parts.push(step.note);
  if (step.desc) parts.push(step.desc);
  return parts.join(" — ");
}

function wmRenderStepsList(elId, steps, completedCount = 0) {
  const list = document.getElementById(elId);
  if (!list) return;
  list.innerHTML = steps.map((s, i) => {
    const tooltip = wmTooltipText(s) + (s.skipped ? " — Skipped (not required for this model)" : "");
    const skipTag = s.skipped ? ` <span class="wm-seq-skip-tag">(skipped)</span>` : "";
    let cls = "pending";
    if (s.skipped && i < completedCount) cls = "skipped";
    else if (i < completedCount) cls = "done";
    return `<li class="wm-seq-step ${cls}" title="${escapeHtml(tooltip)}"><span class="wm-seq-num">${i + 1}</span>${s.label}${skipTag}</li>`;
  }).join("");
}

function wmRenderAutoSeqPreviewList(elId, steps, round) {
  const list = document.getElementById(elId);
  if (!list) return;
  list.innerHTML = steps.map((s, i) => {
    const label = s.firstLabel ? (round === "first" ? s.firstLabel : s.loopLabel) : s.label;
    const tooltip = wmTooltipText({ ...s, label }) + (s.skipped ? " — Skipped (not required for this model)" : "");
    const skipTag = s.skipped ? ` <span class="wm-seq-skip-tag">(skipped)</span>` : "";
    return `<li class="wm-seq-step pending" title="${escapeHtml(tooltip)}"><span class="wm-seq-num">${i + 1}</span>${label}${skipTag}</li>`;
  }).join("");
}

function wmRenderAutoSequenceContent(mode) {
  const wrap = document.getElementById("wm-auto-seq-wrap");
  if (!wrap) return;
  const info = wmAutoModeInfo(mode);

  if (info.kind === "single") {
    wrap.innerHTML = `
      <div class="wm-auto-seq-single">
        <div class="card-title" style="margin-top:4px;">Activation <span style="font-weight:400;color:var(--ink-faint);font-size:11px;">(runs once, on Set)</span></div>
        <ol class="wm-seq-list wm-auto-activation-list" id="wm-auto-activation-list"></ol>
        <div class="card-title" style="margin-top:10px;">Loop Cycle <span style="font-weight:400;color:var(--ink-faint);font-size:11px;">(repeats every 2-hand start — pallet swaps in to mark, then back out)</span></div>
        <ol class="wm-seq-list" id="wm-auto-loop-list"></ol>
      </div>`;
    const job = getSelectedJob(info.pallet);
    wmRenderStepsList("wm-auto-activation-list", AUTO_SINGLE_ACTIVATION_STEPS(info.palletNum));
    wmRenderStepsList("wm-auto-loop-list", applySkipFlags(AUTO_SINGLE_LOOP_STEPS, job));
  } else {
    wrap.innerHTML = `
      <div class="wm-auto-seq-dual">
        <div class="card-title" style="margin-top:4px;">Activation <span style="font-weight:400;color:var(--ink-faint);font-size:11px;">(runs once, on Set)</span></div>
        <ol class="wm-seq-list wm-auto-activation-list" id="wm-auto-activation-list"></ol>
        <div class="wm-auto-seq-cols" style="margin-top:10px;">
          <div class="wm-auto-seq-col">
            <div class="card-title" style="margin-top:4px;">First Cycle <span style="font-weight:400;color:var(--ink-faint);font-size:11px;">(runs once, on the first 2-hand start)</span></div>
            <ol class="wm-seq-list" id="wm-auto-first-list"></ol>
          </div>
          <div class="wm-auto-seq-col">
            <div class="card-title" style="margin-top:4px;">Loop Cycle <span style="font-weight:400;color:var(--ink-faint);font-size:11px;">(repeats after every following 2-hand start)</span></div>
            <ol class="wm-seq-list" id="wm-auto-loop-list"></ol>
          </div>
        </div>
      </div>`;
    const nextPallet = monPeekNextAutoPallet(mode);
    const job = getSelectedJob(nextPallet);
    const steps = applySkipFlags(AUTO_SEQUENCE_STEPS, job);
    wmRenderStepsList("wm-auto-activation-list", AUTO_DUAL_ACTIVATION_STEPS);
    wmRenderAutoSeqPreviewList("wm-auto-first-list", steps, "first");
    wmRenderAutoSeqPreviewList("wm-auto-loop-list", steps, "loop");
  }
}

async function wmActivateAutoMode(mode) {
  const info = wmAutoModeInfo(mode);
  showToast(`Mode changed to ${mode}.`, "success", 1800);

  let activationSteps = info.kind === "single"
    ? AUTO_SINGLE_ACTIVATION_STEPS(info.palletNum)
    : AUTO_DUAL_ACTIVATION_STEPS;

  if (info.kind === "single") {
    wmLog(`>>> Auto mode ${mode} activated — running ${activationSteps.map((s) => s.label).join(", ")}`);
  } else {
    wmLog(`>>> Auto mode ${mode} activated — running ${activationSteps.map((s) => s.label).join(", ")}`);
  }

  for (let i = 0; i < activationSteps.length; i++) {
    const step = activationSteps[i];
    try {
      const result = await step.fn();
      if (!result || result.ok !== false) {
        wmRenderStepsList("wm-auto-activation-list", activationSteps, i + 1);
      }
    } catch (err) {
      // keep current view; errors will still surface in the log below
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));

  MON_AUTO.queue = 0;
  MON_AUTO.running = false;
  MON_AUTO.roundCount = { Pallet1: 0, Pallet2: 0 };
  MON_AUTO.palletCycleIndex = 0;
  setTimeout(() => loadPage("monitor"), 0);
}

const WM_GROUP_LABELS = {
  io: "Doors",
  pallet: "Pallet",
  vision: "Vision / 2D Code",
  laser: "Laser",
};
function wmRenderFnGroups() {
  const wrap = document.getElementById("wm-fn-groups");
  if (!wrap) return;
  const byGroup = {};
  Object.entries(WM_FUNCTIONS).forEach(([key, fn]) => {
    (byGroup[fn.group] ||= []).push({ key, ...fn });
  });
  wrap.innerHTML = Object.entries(byGroup)
    .map(
      ([group, fns]) => `
    <div class="wm-fn-group">
      <div class="wm-fn-group-label">${WM_GROUP_LABELS[group] || group}</div>
      <div class="wm-fn-btn-row">
        ${fns
          .map(
            (fn) => `
          <button type="button" class="btn wm-fn-btn" data-fn="${fn.key}" title="${escapeHtml(fn.desc)}">
            ${fn.label}
          </button>`
          )
          .join("")}
      </div>
    </div>`
    )
    .join("");

  wrap.querySelectorAll(".wm-fn-btn").forEach((btn) => {
    btn.addEventListener("click", () => wmRunSingleFunction(btn.dataset.fn, btn));
  });
}

async function wmRunSingleFunction(key, btn) {
  const fn = WM_FUNCTIONS[key];
  if (!fn) return;
  btn.disabled = true;
  const verdict = await fn.run();
  btn.disabled = false;
  if (!verdict.ok) {
    wmLog(`!!! ${fn.label} failed: ${verdict.message}`, "error");
    if (verdict.alarm) showToast(`Alarm: ${fn.label} — ${verdict.message}`);
  }
}

// skipIf(job): when true for the pallet's currently selected model, the
// step renders yellow ("skipped") and its fn is NOT called — it counts
// as passed instead of run. job may be null if no model is selected.
const WM_START_SEQUENCE = [
  { id: "cond_start", label: "Condition Start Loop", note: "D001 ON, D002 ON — 2-hand start pushed", fn: () => wmStub("CONDITION_START_LOOP", 200) },
  { id: "close_front", label: "Close Front Door", fn: WM_FUNCTIONS.CLOSE_FRONT_DOOR.run },
  { id: "camera_check", label: "Camera Check", fn: WM_FUNCTIONS.CAMERA_TRIGGER.run,
    skipIf: (job) => !!job && !job.check_camera },
  { id: "change_pallet", label: "Change Pallet", fn: WM_FUNCTIONS.CHANGE_PALLET.run },
  { id: "open_front", label: "Open Front Door", fn: WM_FUNCTIONS.OPEN_FRONT_DOOR.run },
  { id: "start_marking", label: "Start Marking", fn: WM_FUNCTIONS.START_MARKING.run },
  { id: "code_start", label: "2D Code: Start Reader", fn: WM_FUNCTIONS.CODE2D_START_READER.run,
    skipIf: (job) => !!job && !job.check_start2dcode },
  { id: "code_result", label: "2D Code: Read Result", fn: WM_FUNCTIONS.CODE2D_RESULT_READER.run,
    skipIf: (job) => !!job && !job.check_read2dcode },
  { id: "code_grade", label: "2D Code: Grade Result", fn: WM_FUNCTIONS.CODE2D_GRADE_RESULT.run,
    skipIf: (job) => !!job && !job.check_grade2dcode },
  { id: "cond_end", label: "Condition End Loop", fn: () => wmStub("CONDITION_END_LOOP", 200) },
];

function wmComputeStepsForJob(job) {
  return WM_START_SEQUENCE.map((s) => ({
    ...s,
    skipped: typeof s.skipIf === "function" ? !!s.skipIf(job) : false,
  }));
}

function wmRenderStartSeqList(steps, activeIndex = -1, doneUpTo = -1, failState = null) {
  const list = document.getElementById("wm-start-seq-list");
  if (!list) return;
  list.innerHTML = steps.map((s, i) => {
    let cls = "pending";
    if (failState && i === activeIndex) {
      cls = failState; // 'alarm' | 'blocked'
    } else if (s.skipped && i <= Math.max(doneUpTo, activeIndex)) {
      cls = "skipped";
    } else if (i <= doneUpTo) {
      cls = "done";
    } else if (i === activeIndex) {
      cls = "active";
    }
    const tooltip = wmTooltipText(s) + (s.skipped ? " — Skipped (not required for this model)" : "");
    const skipTag = s.skipped ? ` <span class="wm-seq-skip-tag">(skipped)</span>` : "";
    return `<li class="wm-seq-step ${cls}" title="${escapeHtml(tooltip)}"><span class="wm-seq-num">${i + 1}</span>${s.label}${skipTag}</li>`;
  }).join("");
}

function wmRenderStartButtonsEnabled() {
  const p1Btn = document.getElementById("wm-start-marking-p1-btn");
  const p2Btn = document.getElementById("wm-start-marking-p2-btn");
  if (!p1Btn || !p2Btn) return;
  if (WM.manualRunning) return; // don't fight the running/disabled state
  p1Btn.disabled = WM_PALLET_STATE.operatorRoomPallet !== "Pallet1";
  p2Btn.disabled = WM_PALLET_STATE.operatorRoomPallet !== "Pallet2";
}

function wmUpdatePalletLocationUI() {
  const valueEl = document.getElementById("wm-pallet-location-value");
  if (valueEl) {
    valueEl.textContent = WM_PALLET_STATE.operatorRoomPallet === "Pallet1" ? "Pallet 1" : "Pallet 2";
  }
  wmRenderStartButtonsEnabled();
  // Keep the sequence preview in sync with whichever pallet is reachable
  // right now, and with its currently selected model's checks.
  if (!WM.manualRunning) {
    const job = getSelectedJob(WM_PALLET_STATE.operatorRoomPallet);
    wmRenderStartSeqList(wmComputeStepsForJob(job), -1, -1);
  }
}

function wmSetStartButtonsState(state, activePallet) {
  const p1Btn = document.getElementById("wm-start-marking-p1-btn");
  const p2Btn = document.getElementById("wm-start-marking-p2-btn");
  if (!p1Btn || !p2Btn) return;

  if (state === "running") {
    p1Btn.disabled = true;
    p2Btn.disabled = true;
    const runningBtn = activePallet === "Pallet1" ? p1Btn : p2Btn;
    runningBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Running…';
  } else {
    p1Btn.innerHTML = "&#9654; Start Marking Pallet 1";
    p2Btn.innerHTML = "&#9654; Start Marking Pallet 2";
    wmRenderStartButtonsEnabled();
  }
}

function wmStopSequence() {
  WM.manualRunning = false;
  WM.runningPallet = null;
  wmSetStartButtonsState("idle");
  const job = getSelectedJob(WM_PALLET_STATE.operatorRoomPallet);
  wmRenderStartSeqList(wmComputeStepsForJob(job), -1, -1);
}

async function wmRunStartSequenceForPallet(pallet) {
  if (WM.manualRunning) return;

  if (WM_PALLET_STATE.operatorRoomPallet !== pallet) {
    showToast(`${pallet === "Pallet1" ? "Pallet 1" : "Pallet 2"} is not in the Operator Room. Use Call Pallet / Change Pallet first.`);
    return;
  }

  const job = getSelectedJob(pallet);
  if (!job) {
    showToast(`Select a model for ${pallet === "Pallet1" ? "Pallet 1" : "Pallet 2"} on Model Setting first.`);
    return;
  }

  WM.manualRunning = true;
  WM.runningPallet = pallet;
  wmSetStartButtonsState("running", pallet);
  monInitCheckStatusForJob(pallet, job); // reset to pending/skipped for this run

  const steps = wmComputeStepsForJob(job);
  wmRenderStartSeqList(steps, -1, -1);
  wmLog(`>>> Start Marking (${pallet}) — ${job.model} / Job ${padJob(job.job_no)}`);

  for (let i = 0; i < steps.length; i++) {
    if (!WM.manualRunning) return; // stopped externally (e.g. page navigation)
    wmRenderStartSeqList(steps, i, i - 1);

    if (steps[i].skipped) {
      monApplyStepResult(pallet, steps[i], true);
      wmLog(`--- ${steps[i].label}: skipped (not required for this model) ---`, "warn");
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }

    let verdict;
    try {
      verdict = await steps[i].fn();
    } catch (err) {
      verdict = { ok: false, alarm: true, message: String(err) };
    }
    if (!verdict.ok) {
      monApplyStepResult(pallet, steps[i], false);
      WM.manualRunning = false;
      WM.runningPallet = null;
      wmRenderStartSeqList(steps, i, i - 1, verdict.alarm ? "alarm" : "blocked");
      wmLog(`!!! ${steps[i].label} failed: ${verdict.message}`, "error");
      wmSetStartButtonsState("idle");
      if (verdict.alarm) showToast(`Alarm: ${steps[i].label} — ${verdict.message}`);
      return;
    }
    monApplyStepResult(pallet, steps[i], true);
  }

  WM.manualRunning = false;
  WM.runningPallet = null;
  wmRenderStartSeqList(steps, -1, steps.length - 1);
  wmLog(`--- Start Marking sequence complete (${pallet}) ---`, "ok");
  wmSetStartButtonsState("idle");
}

/* ============================================================
   FOR ALARM CENTER PAGE
   ============================================================
   NOTE: The equipment backend isn't wired up yet (hardware still
   arriving), so this page runs entirely on mock data below.
   When the backend is ready, replace acFetchAlarms()'s body with:
     const [curRes, histRes] = await Promise.all([
       apiFetch('/api/alarms/current'),
       apiFetch('/api/alarms/history'),
     ]);
     AC.current = await curRes.json();
     AC.history = await histRes.json();
   and acResetAlarm() with a real call to
     POST /api/alarms/:id/reset  -> { cleared: bool, alarm? }
   Nothing else on this page needs to change.
   ============================================================ */

const AC_SOURCE_ICONS = {
  "MD-X2520A": "fa-solid fa-bullseye",
  "IAI Elecylinder": "fa-solid fa-arrows-left-right",
  "MySQL": "fa-solid fa-database",
  "Modbus I/O": "fa-solid fa-microchip",
  "Node API": "fa-solid fa-server",
};

// Each mock alarm carries `clearsAfterAttempts` purely so the "Reset &
// Check Again" flow has something realistic to demo without hardware:
// it simulates the alarm clearing after that many reset attempts.
const AC_MOCK_CURRENT = [
  {
    id: 1,
    tag: "ERR_READY_1",
    source: "MD-X2520A",
    severity: "error",
    description: "Laser marker reports RX,Ready=1 (active error on the unit).",
    occurred_at: "2026-08-28T08:12:00",
    instructions: [
      "Check the marker's front panel display for the specific error code.",
      "Clear the error on the unit itself (or send WX,ErrorClear from Equipment > Raw Command).",
      "Confirm the laser safety shutter and enclosure are fully closed.",
      "Click \"Reset & Check Again\" below once the error is cleared on the unit.",
    ],
    clearsAfterAttempts: 1,
    attempts: 0,
  },
  {
    id: 2,
    tag: "IO_DISCONNECT",
    source: "Modbus I/O",
    severity: "error",
    description: "ETH-MODBUS-IO16R module (door / pallet cylinder I/O) is not responding on the network.",
    occurred_at: "2026-08-28T08:05:30",
    instructions: [
      "Check the module's power and Ethernet cable at the IPC panel.",
      "Ping the module's IP from the IPC to confirm it's on the network.",
      "Power-cycle the module if the link light is off.",
      "Click \"Reset & Check Again\" once the module is back online.",
    ],
    clearsAfterAttempts: 2,
    attempts: 0,
  },
  {
    id: 3,
    tag: "CYL_TIMEOUT",
    source: "IAI Elecylinder",
    severity: "warn",
    description: "Cylinder EC-GS4 (pallet exchange) did not reach target position within timeout.",
    occurred_at: "2026-08-28T07:58:10",
    instructions: [
      "Check for a physical obstruction along the cylinder's travel path.",
      "Verify 24V supply to the elecylinder driver.",
      "Home the axis from the driver's front panel if available.",
      "Click \"Reset & Check Again\" to re-check the position.",
    ],
    clearsAfterAttempts: 1,
    attempts: 0,
  },
  {
    id: 4,
    tag: "DB_CONN_LOST",
    source: "MySQL",
    severity: "warn",
    description: "Node API gateway lost its connection pool to the MySQL database.",
    occurred_at: "2026-08-28T07:40:00",
    instructions: [
      "Check that the MySQL service is running on the host in backend/node/.env.",
      "Check network connectivity between the Node gateway and the DB host.",
      "Restart the Node API gateway (npm run dev / npm start) if MySQL is confirmed up.",
      "Click \"Reset & Check Again\" to re-test the connection.",
    ],
    clearsAfterAttempts: 1,
    attempts: 0,
  },
];

const AC_MOCK_HISTORY = [
  {
    id: 101,
    tag: "ERR_READY_1",
    source: "MD-X2520A",
    severity: "error",
    description: "Laser marker reports RX,Ready=1 (active error on the unit).",
    occurred_at: "2026-08-27T14:02:00",
    resolved_at: "2026-08-27T14:11:00",
    resolution: "Enclosure interlock sensor was misaligned; realigned and error cleared.",
  },
  {
    id: 102,
    tag: "CYL_TIMEOUT",
    source: "IAI Elecylinder",
    severity: "warn",
    description: "Cylinder EC-GS4 (pallet exchange) did not reach target position within timeout.",
    occurred_at: "2026-08-26T09:15:00",
    resolved_at: "2026-08-26T09:22:00",
    resolution: "Loose bracket was catching on the rail; retightened, cylinder homed successfully.",
  },
  {
    id: 103,
    tag: "IO_DISCONNECT",
    source: "Modbus I/O",
    severity: "error",
    description: "ETH-MODBUS-IO16R module (door / pallet cylinder I/O) is not responding on the network.",
    occurred_at: "2026-08-25T11:30:00",
    resolved_at: "2026-08-25T11:34:00",
    resolution: "Ethernet cable had come loose during panel maintenance; reseated.",
  },
];

const AC = {
  tab: "current",
  current: [],
  history: [],
  selectedId: null,
  resetting: false,
};

function acSeverityLabel(sev) {
  return { error: "Error", warn: "Warning", info: "Info" }[sev] || sev;
}

function acFormatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function acDuration(startIso, endIso) {
  const ms = new Date(endIso) - new Date(startIso);
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

async function acFetchAlarms() {
  // Placeholder data source — see NOTE at top of this section.
  AC.current = AC_MOCK_CURRENT.map((a) => ({ ...a }));
  AC.history = AC_MOCK_HISTORY.map((a) => ({ ...a }));
}

function acRenderCounts() {
  document.getElementById("ac-count-current").textContent = AC.current.length;
  document.getElementById("ac-count-history").textContent = AC.history.length;
}

function acSourceBadge(source) {
  const icon = AC_SOURCE_ICONS[source] || "fa-solid fa-plug";
  return `<span class="ac-source-badge"><i class="${icon}"></i> ${escapeHtml(source)}</span>`;
}

function acRenderTable() {
  const head = document.getElementById("ac-table-head");
  const body = document.getElementById("ac-table-body");
  const title = document.getElementById("ac-list-title");
  const isCurrent = AC.tab === "current";
  const rows = isCurrent ? AC.current : AC.history;

  title.textContent = isCurrent ? "Current Alarms" : "History Alarms";

  head.innerHTML = isCurrent
    ? `<tr><th>#</th><th>Tag</th><th>Source</th><th>Description</th><th>Severity</th><th>Occurred</th></tr>`
    : `<tr><th>#</th><th>Tag</th><th>Source</th><th>Description</th><th>Occurred</th><th>Resolved</th></tr>`;

  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="6" class="eq-queue-empty">${isCurrent ? "No active alarms. All clear." : "No alarm history yet."}</td></tr>`;
    return;
  }

  body.innerHTML = rows
    .map((a, i) => {
      const selected = a.id === AC.selectedId ? "ac-row-selected" : "";
      if (isCurrent) {
        return `
          <tr class="ac-row ${selected}" data-id="${a.id}">
            <td class="mono">${i + 1}</td>
            <td class="mono">${escapeHtml(a.tag)}</td>
            <td>${acSourceBadge(a.source)}</td>
            <td>${escapeHtml(a.description)}</td>
            <td><span class="ac-sev ac-sev-${a.severity}">${acSeverityLabel(a.severity)}</span></td>
            <td class="mono">${acFormatDate(a.occurred_at)}</td>
          </tr>`;
      }
      return `
        <tr class="ac-row ${selected}" data-id="${a.id}">
          <td class="mono">${i + 1}</td>
          <td class="mono">${escapeHtml(a.tag)}</td>
          <td>${acSourceBadge(a.source)}</td>
          <td>${escapeHtml(a.description)}</td>
          <td class="mono">${acFormatDate(a.occurred_at)}</td>
          <td class="mono">${acFormatDate(a.resolved_at)}</td>
        </tr>`;
    })
    .join("");

  body.querySelectorAll(".ac-row").forEach((tr) => {
    tr.addEventListener("click", () => acSelect(Number(tr.dataset.id)));
  });
}

function acFindSelected() {
  const list = AC.tab === "current" ? AC.current : AC.history;
  return list.find((a) => a.id === AC.selectedId) || null;
}

function acRenderDetail() {
  const empty = document.getElementById("ac-detail-empty");
  const bodyEl = document.getElementById("ac-detail-body");
  const alarm = acFindSelected();

  if (!alarm) {
    empty.style.display = "flex";
    bodyEl.style.display = "none";
    return;
  }
  empty.style.display = "none";
  bodyEl.style.display = "block";

  const isCurrent = AC.tab === "current";

  const instructionsHtml = isCurrent
    ? `
      <div class="ac-instructions">
        <div class="ac-instructions-label">What to do</div>
        <ol class="ac-step-list">
          ${alarm.instructions.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}
        </ol>
      </div>`
    : `
      <div class="ac-instructions">
        <div class="ac-instructions-label">Resolution</div>
        <p class="ac-resolution-text">${escapeHtml(alarm.resolution || "—")}</p>
      </div>`;

  const footerHtml = isCurrent
    ? `
      <div class="ac-detail-footer">
        <button class="btn btn-primary" id="ac-reset-btn" ${AC.resetting ? "disabled" : ""}>
          <i class="fa-solid fa-rotate${AC.resetting ? " fa-spin" : ""}"></i>
          ${AC.resetting ? "Checking…" : "Reset & Check Again"}
        </button>
        <span class="ac-attempts-note">Attempts so far: ${alarm.attempts}</span>
      </div>
      <div id="ac-reset-result"></div>`
    : `
      <div class="ac-detail-footer">
        <span class="ac-attempts-note">Resolved after ${acDuration(alarm.occurred_at, alarm.resolved_at)}</span>
      </div>`;

  bodyEl.innerHTML = `
    <div class="ac-detail-top">
      <span class="ac-sev ac-sev-${alarm.severity}">${acSeverityLabel(alarm.severity)}</span>
      <span class="ac-detail-tag mono">${escapeHtml(alarm.tag)}</span>
      ${acSourceBadge(alarm.source)}
    </div>
    <table class="data-table ac-detail-table">
      <tbody>
        <tr><td>Description</td><td colspan="2">${escapeHtml(alarm.description)}</td></tr>
        <tr><td>Occurred</td><td colspan="2" class="mono">${acFormatDate(alarm.occurred_at)}</td></tr>
        ${!isCurrent ? `<tr><td>Resolved</td><td colspan="2" class="mono">${acFormatDate(alarm.resolved_at)}</td></tr>` : ""}
      </tbody>
    </table>
    ${instructionsHtml}
    ${footerHtml}
  `;

  if (isCurrent) {
    document.getElementById("ac-reset-btn").addEventListener("click", () => acResetAlarm(alarm.id));
  }
}

function acSelect(id) {
  AC.selectedId = id;
  acRenderTable();
  acRenderDetail();
}

async function acResetAlarm(id) {
  const alarm = AC.current.find((a) => a.id === id);
  if (!alarm || AC.resetting) return;

  AC.resetting = true;
  acRenderDetail();

  // Placeholder: replace with a real POST /api/alarms/:id/reset call that
  // re-checks the underlying condition and returns { cleared: bool }.
  await new Promise((resolve) => setTimeout(resolve, 900));

  alarm.attempts += 1;
  const cleared = alarm.attempts >= alarm.clearsAfterAttempts;
  AC.resetting = false;

  const resultBox = document.getElementById("ac-reset-result");

  if (cleared) {
    AC.current = AC.current.filter((a) => a.id !== id);
    AC.history = [
      {
        id: 1000 + id,
        tag: alarm.tag,
        source: alarm.source,
        severity: alarm.severity,
        description: alarm.description,
        occurred_at: alarm.occurred_at,
        resolved_at: new Date().toISOString(),
        resolution: "Cleared after operator followed the listed recovery steps and reset.",
      },
      ...AC.history,
    ];
    AC.selectedId = null;
    acRenderCounts();
    acRenderTable();
    acRenderDetail();
    showToast(`${alarm.tag} cleared and moved to history.`, "success");
  } else {
    acRenderTable();
    acRenderDetail();
    if (resultBox) {
      // acRenderDetail rebuilds the DOM, so re-fetch the fresh node.
    }
    const freshBox = document.getElementById("ac-reset-result");
    if (freshBox) {
      freshBox.innerHTML = `<div class="alert alert-error" style="margin-top:10px;">Alarm is still present. Please complete the steps above and try again.</div>`;
    }
    showToast(`${alarm.tag} is still active.`, "error");
  }
}

PAGE_INIT.alarm_center = function () {
  AC.tab = "current";
  AC.selectedId = null;

  document.querySelectorAll(".ac-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".ac-tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      AC.tab = btn.dataset.tab;
      AC.selectedId = null;
      acRenderTable();
      acRenderDetail();
    });
  });

  document.getElementById("ac-refresh-btn").addEventListener("click", async () => {
    await acFetchAlarms();
    acRenderCounts();
    acRenderTable();
    acRenderDetail();
    document.getElementById("ac-last-updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
  });

  (async () => {
    await acFetchAlarms();
    acRenderCounts();
    acRenderTable();
    acRenderDetail();
    document.getElementById("ac-last-updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
  })();
};

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
  const photoWrap = document.getElementById(`ms-photo-${pallet}`);
  const infoWrap = document.getElementById(`ms-info-${pallet}`);
  const condWrap = document.getElementById(`ms-cond-${pallet}`);
  if (!photoWrap || !infoWrap || !condWrap) return;

  if (!condition) {
    photoWrap.innerHTML = `<div class="ms-photo-placeholder"><i class="fa-regular fa-image"></i><span>No model selected</span></div>`;
    infoWrap.innerHTML = `<div class="ms-empty">Select a job to see its details.</div>`;
    condWrap.innerHTML = `<div class="ms-empty">Select a job to see its conditions.</div>`;
    return;
  }

  const items = condition.conditions || [];

  // ---- inner col1 / row1: photo ----
  photoWrap.innerHTML = condition.photo_path
    ? `<img src="${condition.photo_path}" alt="${escapeHtml(condition.model)}" />`
    : `<div class="ms-photo-placeholder"><i class="fa-regular fa-image"></i><span>No photo yet</span></div>`;

  // ---- inner col1 / row2: basic detail table ----
  infoWrap.innerHTML = `
    <table class="data-table ms-detail-table compact">
      <tbody>
        <tr><td>Model</td><td>${escapeHtml(condition.model)}</td></tr>
        <tr><td>Job No.</td><td class="mono">${padJob(condition.job_no)}</td></tr>
        <tr><td>Start 2D Code</td><td>${condition.check_start2dcode ? "Yes" : "No"}</td></tr>
        <tr><td>Read 2D Code</td><td>${condition.check_read2dcode ? "Yes" : "No"}</td></tr>
        <tr><td>Grade 2D Code</td><td>${condition.check_grade2dcode ? "Yes" : "No"}</td></tr>
        <tr><td>Control Grade</td><td>${escapeHtml(condition.control_grade) || "—"}</td></tr>
        <tr><td>Camera</td><td>${condition.check_camera ? "Yes" : "No"}</td></tr>
      </tbody>
    </table>
  `;

  // ---- inner col2: scrollable editable conditions (select is already in the HTML above this block) ----
  const cameraRow = `
  <div class="ms-cond-edit-row ms-camera-row">
    <div class="ms-cond-edit-meta">
      <span class="ms-cond-edit-name">Camera Check</span>
      <span class="ms-cond-edit-blk mono">${condition.check_camera ? "Enabled" : "Disabled — bypassed"}</span>
    </div>
    <button type="button" class="btn btn-sm ${condition.check_camera ? "btn-danger" : "btn-primary"} ms-camera-toggle-btn" data-current="${condition.check_camera ? "1" : "0"}">
      ${condition.check_camera ? "Turn OFF" : "Turn ON"}
    </button>
  </div>`;

  const lotNoRow = `
  <div class="ms-cond-edit-row ms-lotno-row">
    <div class="ms-cond-edit-meta">
      <span class="ms-cond-edit-name">Lot No.</span>
      <span class="ms-cond-edit-blk mono">Not marked</span>
    </div>
    <input type="text" class="ms-cond-edit-input ms-lotno-input" value="${escapeHtml(condition.lot_no || "")}" />
    <button type="button" class="btn btn-sm btn-primary ms-lotno-set-btn">Set</button>
  </div>`;

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

  condWrap.innerHTML = `
    <div class="card-title" style="margin-top:0;">Conditions <span style="font-weight:400;color:var(--ink-faint);font-size:11px;">(operators can update values)</span></div>
    <div class="ms-cond-edit-list">${cameraRow}${lotNoRow}${editableRows}</div>
  `;

  condWrap.querySelectorAll(".ms-cond-set-btn").forEach((btn) => {
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

  const lotNoBtn = condWrap.querySelector(".ms-lotno-set-btn");
  if (lotNoBtn) {
    lotNoBtn.addEventListener("click", () => {
      const input = condWrap.querySelector(".ms-lotno-input");
      const newValue = input.value.trim();
      if (!newValue) { showToast("Lot No. cannot be empty."); return; }
      if (newValue === condition.lot_no) { showToast("No change.", "info"); return; }
      MS.pendingSet = { pallet, modelId: condition.id, itemId: null, newValue, oldValue: condition.lot_no, name: "Lot No.", isLotNo: true };
      document.getElementById("ms-confirm-text").textContent =
        `Change "Lot No." from "${condition.lot_no || "(empty)"}" to "${newValue}"? This is only logged with each part counted — it is not marked on the workpiece.`;
      document.getElementById("ms-confirm-backdrop").classList.add("open");
    });
  }

  const cameraBtn = condWrap.querySelector(".ms-camera-toggle-btn");
  if (cameraBtn) {
    cameraBtn.addEventListener("click", () => {
      const newValue = cameraBtn.dataset.current !== "1"; // toggle
      MS.pendingSet = { pallet, modelId: condition.id, itemId: null, newValue, oldValue: condition.check_camera, name: "Camera Check", isCamera: true };
      document.getElementById("ms-confirm-text").textContent = newValue
        ? "Re-enable Camera Check for this model?"
        : "Disable Camera Check for this model? Marking will proceed without a camera check until an Engineer re-enables it.";
      document.getElementById("ms-confirm-backdrop").classList.add("open");
    });
  }
}

async function msConfirmSetValue() {
  const p = MS.pendingSet;
  document.getElementById("ms-confirm-backdrop").classList.remove("open");
  if (!p) return;
  try {
    const url = p.isCamera
      ? `/api/models/${p.modelId}/camera`
      : p.isLotNo
      ? `/api/models/${p.modelId}/lotno`
      : `/api/models/${p.modelId}/conditions/${p.itemId}`;
    const body = p.isCamera
      ? { check_camera: p.newValue }
      : p.isLotNo
      ? { lot_no: p.newValue }
      : { condition_value: p.newValue };
    const res = await apiFetch(url, { method: "PATCH", body: JSON.stringify(body) });
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
  
  // document.getElementById("ms-f-lotno-block").value = condition && condition.lot_no_block != null ? condition.lot_no_block : 0;
  document.getElementById("ms-f-lotno-value").value = condition && condition.lot_no ? condition.lot_no : "";

  const photoInputEl = document.getElementById("ms-f-photo");
  photoInputEl.value = "";
  const photoPreviewEl = document.getElementById("ms-f-photo-preview");
  if (condition && condition.photo_path) {
    photoPreviewEl.src = condition.photo_path;
    photoPreviewEl.style.display = "";
  } else {
    photoPreviewEl.style.display = "none";
  }

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

function msCollectFormData() {
  const fd = new FormData();
  fd.append("model", document.getElementById("ms-f-model").value.trim());
  fd.append("job_no", document.getElementById("ms-f-jobno").value);
  fd.append("pallet_no", document.getElementById("ms-f-pallet").value);
  fd.append("check_start2dcode", document.getElementById("ms-f-start2d").checked ? "1" : "");
  fd.append("start2dcode_params", JSON.stringify(msCaptureStart2DValues()));
  fd.append("check_read2dcode", document.getElementById("ms-f-read2d").checked ? "1" : "");
  fd.append("read2dcode_detailed", document.getElementById("ms-f-read2d-detailed").value.trim() || "0");
  fd.append("check_grade2dcode", document.getElementById("ms-f-grade2d").checked ? "1" : "");
  fd.append("control_grade", document.getElementById("ms-f-grade").value.trim());
  fd.append("check_camera", document.getElementById("ms-f-camera").checked ? "1" : "");
  fd.append("conditions", JSON.stringify(msCaptureConditionsFromDom()));
  // fd.append("lot_no_block", document.getElementById("ms-f-lotno-block").value);
  fd.append("lot_no", document.getElementById("ms-f-lotno-value").value.trim());
  const photoFile = document.getElementById("ms-f-photo").files[0];
  if (photoFile) fd.append("photo", photoFile);
  return fd;
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
      wmUpdatePalletLocationUI(); // refresh Start Marking preview if this pallet is currently in the Operator Room
    });
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

  // ---- Work Mode (moved in from the former Work Mode page) ----
  const savedMode = wmLoadMode();
  document.getElementById("wm-mode-select").value = savedMode || "";
  wmApplyMode(savedMode);

  document.getElementById("wm-set-mode-btn").addEventListener("click", () => {
    const value = document.getElementById("wm-mode-select").value;
    if (!value) { showToast("Choose a mode first."); return; }
    const isAuto = value === "AUTO1-2" || value === "AUTO1" || value === "AUTO2";

    wmApplyMode(value); // renders pallet-status row / block visibility either way

    if (!isAuto) {
      showToast(`Mode set to ${value}.`, "success");
      return;
    }

    const readiness = wmCheckPalletsReady(value);
    if (!readiness.ok) {
      showToast(
        `Select a model for ${readiness.missing.join(" and ")} before activating ${value}.`,
        "error"
      );
      // Don't run activation steps or navigate — stay here so the
      // "⚠ No model selected" pallet-status card stays visible.
      return;
    }

    wmActivateAutoMode(value);
  });

  wmRenderFnGroups();
  wmUpdatePalletLocationUI(); // sets pill text, button enable/disable, initial seq preview
  document.getElementById("wm-start-marking-p1-btn").addEventListener("click", () => wmRunStartSequenceForPallet("Pallet1"));
  document.getElementById("wm-start-marking-p2-btn").addEventListener("click", () => wmRunStartSequenceForPallet("Pallet2"));

  document.getElementById("wm-clear-log-btn").addEventListener("click", () => {
    document.getElementById("wm-manual-log").innerHTML = "";
  });
};

PAGE_TEARDOWN.model_setting = function () {
  WM.manualRunning = false;
  wmStopSequence();
};

/* ============================================================
   FOR ADD NEW MODEL PAGE
   ============================================================
   Reuses Model Setting's modal helpers (same field IDs, see
   add_new_model.html header comment) instead of duplicating
   form logic. Only mode switching / model picking / save-delete
   orchestration lives here.
   ============================================================ */
const ANM = {
  mode: "add", // "add" | "editP1" | "editP2"
  list: [],
};

function anmShowForm(show) {
  document.getElementById("anm-form-wrap").style.display = show ? "" : "none";
  document.getElementById("anm-edit-empty").style.display = show ? "none" : "";
}

function anmUpdateSaveBtnLabel() {
  const btn = document.getElementById("anm-save-btn");
  btn.textContent = MS.editingId ? "Save Changes" : "Add Model";
}

// Fills the shared form fields from a condition row (or blanks it for
// a new one) — mirrors msOpenModal() minus the modal title/backdrop.
function anmFillForm(condition) {
  document.getElementById("ms-modal-alert").innerHTML = "";
  document.getElementById("anm-model-form").reset();

  MS.editingId = condition ? condition.id : null;
  document.getElementById("ms-f-id").value = condition ? condition.id : "";
  document.getElementById("ms-f-model").value = condition ? condition.model : "";
  document.getElementById("ms-f-jobno").value = condition ? condition.job_no : "";
  document.getElementById("ms-f-pallet").value = condition
    ? condition.pallet_no
    : (ANM.mode === "editP2" ? "Pallet2" : "Pallet1");

  document.getElementById("ms-f-start2d").checked = condition ? !!condition.check_start2dcode : false;
  msBuildStart2DGrid(condition ? condition.start2dcode_params : null);

  document.getElementById("ms-f-read2d").checked = condition ? !!condition.check_read2dcode : false;
  document.getElementById("ms-f-read2d-detailed").value =
    condition && condition.read2dcode_detailed !== undefined ? condition.read2dcode_detailed : "0";

  document.getElementById("ms-f-grade2d").checked = condition ? !!condition.check_grade2dcode : true;
  document.getElementById("ms-f-grade").value = condition ? condition.control_grade || "" : "";

  document.getElementById("ms-f-camera").checked = condition ? !!condition.check_camera : true;
  document.getElementById("ms-f-lotno-value").value = condition && condition.lot_no ? condition.lot_no : "";

  const photoInputEl = document.getElementById("ms-f-photo");
  photoInputEl.value = "";
  const photoPreviewEl = document.getElementById("ms-f-photo-preview");
  if (condition && condition.photo_path) {
    photoPreviewEl.src = condition.photo_path;
    photoPreviewEl.style.display = "";
  } else {
    photoPreviewEl.style.display = "none";
  }

  document.getElementById("ms-modal-delete-btn").style.display = condition ? "" : "none";

  msToggleCheckParams("ms-f-start2d", "ms-start2d-params-wrap");
  msToggleCheckParams("ms-f-read2d", "ms-read2d-params-wrap");
  msToggleCheckParams("ms-f-grade2d", "ms-grade2d-params-wrap");

  MS.conditions = condition && condition.conditions && condition.conditions.length
    ? condition.conditions.map((c) => ({ ...c }))
    : [{ condition_name: "", condition_value: "", block_no: "" }];
  msRebuildConditionRows();

  anmUpdateSaveBtnLabel();
}

async function anmLoadEditListFor(pallet) {
  const select = document.getElementById("anm-edit-select");
  select.innerHTML = `<option value="">— select —</option>`;
  anmShowForm(false);
  try {
    const res = await apiFetch(`/api/models?pallet=${pallet}`);
    const rows = await res.json();
    ANM.list = rows;
    select.innerHTML =
      `<option value="">— select —</option>` +
      rows.map((r) => `<option value="${r.id}">${escapeHtml(r.model)} · Job ${padJob(r.job_no)}</option>`).join("");
  } catch (err) {
    showToast("Could not load models.");
  }
}

async function anmReloadEditList(clearSelection) {
  const pallet = ANM.mode === "editP2" ? "Pallet2" : "Pallet1";
  const keepId = clearSelection ? null : MS.editingId;
  await anmLoadEditListFor(pallet);
  if (keepId) {
    const condition = ANM.list.find((r) => String(r.id) === String(keepId));
    if (condition) {
      document.getElementById("anm-edit-select").value = keepId;
      anmFillForm(condition);
      anmShowForm(true);
    }
  }
  msLoadConditionNames();
}

function anmSetMode(mode) {
  ANM.mode = mode;
  document.querySelectorAll(".anm-mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  document.getElementById("anm-edit-select-wrap").style.display = mode === "add" ? "none" : "";

  if (mode === "add") {
    anmFillForm(null);
    anmShowForm(true);
  } else {
    anmLoadEditListFor(mode === "editP2" ? "Pallet2" : "Pallet1");
  }
}

PAGE_INIT.add_new_model = function () {
  // ---- Column 1 (model form) setup — unchanged from before ----
  ANM.mode = "add";
  ANM.list = [];
  msLoadConditionNames();

  document.querySelectorAll(".anm-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => anmSetMode(btn.dataset.mode));
  });
  document.getElementById("anm-edit-select").addEventListener("change", () => {
    const id = document.getElementById("anm-edit-select").value;
    if (!id) { anmShowForm(false); return; }
    const condition = ANM.list.find((r) => String(r.id) === id);
    anmFillForm(condition || null);
    anmShowForm(true);
  });
  document.getElementById("ms-f-photo").addEventListener("change", () => {
    const file = document.getElementById("ms-f-photo").files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = document.getElementById("ms-f-photo-preview");
      img.src = e.target.result;
      img.style.display = "";
    };
    reader.readAsDataURL(file);
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
      showToast("Model deleted.", "success");
      await anmReloadEditList(true);
    } catch (err) {
      msModalAlert("Could not reach the server.");
    }
  });
  document.getElementById("anm-model-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!isAdmin()) { showToast("Only admin can save models."); return; }
    document.getElementById("ms-modal-alert").innerHTML = "";
    const fd = msCollectFormData();
    try {
      const res = MS.editingId
        ? await apiFetch(`/api/models/${MS.editingId}`, { method: "PUT", body: fd })
        : await apiFetch(`/api/models`, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        msModalAlert(data.error || "Save failed.");
        return;
      }
      if (ANM.mode === "add") {
        showToast("Model added.", "success");
        anmFillForm(null);
      } else {
        showToast("Model updated.", "success");
        await anmReloadEditList(false);
      }
      msLoadConditionNames();
    } catch (err) {
      msModalAlert("Could not reach the server.");
    }
  });
  anmSetMode("add");

  // ---- Column 2 (MD-X2520A) setup — moved from PAGE_INIT.equipment ----
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

PAGE_TEARDOWN.add_new_model = function () {
  if (EQ.pollTimer) clearInterval(EQ.pollTimer);
  EQ.pollTimer = null;
};

/* ============================================================
   FOR EQUIPMENT PAGE
   ============================================================ */
const EQ = {
  commandGroups: null,
  currentGroup: null,
  currentMode: "wx",
  pollTimer: null,
};

function eqFindGroup(cat, name) {
  if (!EQ.commandGroups || !cat || !name) return null;
  return (EQ.commandGroups[cat] || []).find((g) => g.name === name) || null;
}

function eqSetStatusPill(mode) {
  const pill = document.getElementById("eq-status-pill");
  if (!pill) return;
  const labelMap = { ready: "Ready", busy: "Busy", error: "Error", offline: "Offline" };
  const classes = { ready: "ready", busy: "busy", error: "error", offline: "offline" };
  pill.className = `status-pill ${classes[mode] || "offline"}`;
  pill.innerHTML = `<span class="dot"></span> ${labelMap[mode] || "Offline"}`;
}

function eqGetIpPort() {
  const ipInput = document.getElementById("eq-ip");
  const portInput = document.getElementById("eq-port");
  const ip = ipInput ? ipInput.value.trim() : "10.207.1.254";
  const port = portInput ? Number(portInput.value || 50002) : 50002;
  return { ip, port: Number.isFinite(port) ? port : 50002 };
}

function eqBuildJobButtons() {
  const wrap = document.getElementById("eq-job-buttons");
  if (!wrap) return;
  wrap.innerHTML = [1, 2, 3, 4].map((n) => `
    <button class="eq-job-btn" type="button" data-job="${n}">JOB ${String(n).padStart(4, "0")}</button>
  `).join("");
  wrap.querySelectorAll(".eq-job-btn").forEach((btn) => {
    btn.addEventListener("click", () => eqAddJob(Number(btn.dataset.job)));
  });
}

async function eqAddJob(programNo) {
  const { ip, port } = eqGetIpPort();
  try {
    const res = await apiFetch("/api/equipment/queue", {
      method: "POST",
      body: JSON.stringify({ ip, port, program_no: programNo }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error || "Could not add job to queue.", "error");
      return;
    }
    showToast(`Job ${String(programNo).padStart(4, "0")} queued.`, "success");
    eqPollStatus();
  } catch (err) {
    showToast("Could not reach the laser service.", "error");
  }
}

function eqRenderQueue(queue) {
  const list = document.getElementById("eq-queue-list");
  if (!list) return;
  if (!queue || queue.length === 0) {
    list.innerHTML = '<li class="eq-queue-empty">Queue is empty.</li>';
    return;
  }
  list.innerHTML = queue.map((item) => {
    const statusClass = item.status || "pending";
    const statusLabel = item.status ? item.status.charAt(0).toUpperCase() + item.status.slice(1) : "Pending";
    return `
      <li class="${statusClass}">
        <span>JOB ${String(item.program_no).padStart(4, "0")}</span>
        <span class="job-status">${statusLabel}</span>
      </li>
    `;
  }).join("");
}

async function eqPollStatus() {
  try {
    const res = await apiFetch("/api/equipment/status");
    if (!res.ok) {
      eqSetStatusPill("offline");
      return;
    }
    const data = await res.json();
    eqSetStatusPill(data.connection && data.connection.connected ? "ready" : "offline");
    eqRenderQueue(data.queue || []);
  } catch (err) {
    eqSetStatusPill("offline");
    const list = document.getElementById("eq-queue-list");
    if (list) list.innerHTML = '<li class="eq-queue-empty">Queue unavailable.</li>';
  }
}

async function eqLoadCommands() {
  try {
    const res = await apiFetch("/api/equipment/commands");
    if (!res.ok) return;
    EQ.commandGroups = await res.json();
    const catSelect = document.getElementById("eq-cat-select");
    if (!catSelect) return;
    const cats = Object.keys(EQ.commandGroups || {});
    catSelect.innerHTML = cats.map((cat) => `<option value="${cat}">${cat}</option>`).join("");
    if (cats.length) {
      catSelect.value = cats[0];
      eqOnCategoryChange();
    }
  } catch (err) {
    if (document.getElementById("eq-cat-select")) {
      document.getElementById("eq-cat-select").innerHTML = '<option value="">Unavailable</option>';
    }
  }
}

function eqOnCategoryChange() {
  const cat = document.getElementById("eq-cat-select")?.value || "";
  const cmdSelect = document.getElementById("eq-cmd-select");
  if (!cmdSelect) return;
  const commands = EQ.commandGroups && cat ? EQ.commandGroups[cat] || [] : [];
  cmdSelect.innerHTML = commands.length
    ? commands.map((cmd) => `<option value="${cmd.name}">${cmd.name}</option>`).join("")
    : '<option value="">No commands</option>';
  eqOnCommandChange();
}

function eqOnCommandChange() {
  const cat = document.getElementById("eq-cat-select")?.value || "";
  const cmdName = document.getElementById("eq-cmd-select")?.value || "";
  const paramGrid = document.getElementById("eq-param-grid");
  const descBox = document.getElementById("eq-cmd-desc");
  const previewBox = document.getElementById("eq-preview-box");
  if (!paramGrid || !descBox || !previewBox) return;

  const command = eqFindGroup(cat, cmdName);
  if (!command) {
    descBox.textContent = "Select a category and command above.";
    paramGrid.innerHTML = '<div class="eq-param-empty">No parameters for this command.</div>';
    previewBox.textContent = "";
    return;
  }

  const selectedMode = EQ.currentMode || "wx";
  const variant = selectedMode === "rx" ? command.rx : command.wx;
  descBox.textContent = command.desc || "";

  if (!variant || !variant.params || variant.params.length === 0) {
    paramGrid.innerHTML = '<div class="eq-param-empty">No parameters for this command.</div>';
    previewBox.textContent = variant ? variant.template : "";
    return;
  }

  const paramValues = {};
  const inputs = variant.params.map((param, index) => {
    const defaultValue = param[1] || "";
    const label = param[0] || `Param ${index + 1}`;
    const name = `eq-param-${index}`;
    paramValues[name] = defaultValue;
    return `
      <div class="field">
        <label for="${name}">${label}</label>
        <input id="${name}" data-param-index="${index}" type="text" value="${escapeHtml(defaultValue)}" />
      </div>
    `;
  }).join("");

  paramGrid.innerHTML = inputs;
  paramGrid.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", () => {
      const values = Array.from(paramGrid.querySelectorAll("input")).map((el) => el.value);
      const template = variant.template || "";
      const preview = template.replace(/\{p(\d+)\}/g, (_, i) => values[Number(i)] ?? "");
      previewBox.textContent = preview;
      previewBox.classList.toggle("invalid", preview.includes("(invalid") || preview.trim() === "");
    });
  });

  const values = variant.params.map((param) => param[1] || "");
  const template = variant.template || "";
  previewBox.textContent = template.replace(/\{p(\d+)\}/g, (_, i) => values[Number(i)] ?? "");
  previewBox.classList.remove("invalid");
}

function eqSetMode(mode) {
  EQ.currentMode = mode;
  document.querySelectorAll(".eq-mode-switch button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  eqOnCommandChange();
}

function eqWirePageControls() {
  const connectBtn = document.getElementById("eq-connect-btn");
  if (connectBtn) {
    connectBtn.addEventListener("click", async () => {
      const { ip, port } = eqGetIpPort();
      eqSetStatusPill("busy");
      try {
        const res = await apiFetch("/api/equipment/connect", {
          method: "POST",
          body: JSON.stringify({ ip, port }),
        });
        const data = await res.json();
        eqSetStatusPill(res.ok && data.connected ? "ready" : "error");
        eqPollStatus();
      } catch (err) {
        eqSetStatusPill("error");
      }
    });
  }

  const addCustomBtn = document.getElementById("eq-add-custom-btn");
  if (addCustomBtn) {
    addCustomBtn.addEventListener("click", () => {
      const raw = document.getElementById("eq-custom-job").value.trim();
      const n = parseInt(raw, 10);
      if (Number.isNaN(n) || n < 0 || n > 1999) {
        alert("Enter a job number between 0 and 1999.");
        return;
      }
      eqAddJob(n);
      document.getElementById("eq-custom-job").value = "";
    });
  }

  const clearQueueBtn = document.getElementById("eq-clear-queue-btn");
  if (clearQueueBtn) {
    clearQueueBtn.addEventListener("click", async () => {
      await apiFetch("/api/equipment/queue", { method: "DELETE" });
      eqPollStatus();
    });
  }

  const rawSendBtn = document.getElementById("eq-raw-send-btn");
  if (rawSendBtn) {
    rawSendBtn.addEventListener("click", async () => {
      const { ip, port } = eqGetIpPort();
      const command = document.getElementById("eq-raw-cmd").value.trim();
      if (!command) return;
      await apiFetch("/api/equipment/raw", {
        method: "POST",
        body: JSON.stringify({ ip, port, command }),
      });
      eqPollStatus();
    });
  }

  const catSelect = document.getElementById("eq-cat-select");
  if (catSelect) catSelect.addEventListener("change", eqOnCategoryChange);

  const cmdSelect = document.getElementById("eq-cmd-select");
  if (cmdSelect) cmdSelect.addEventListener("change", eqOnCommandChange);

  const wxBtn = document.getElementById("eq-mode-wx");
  if (wxBtn) wxBtn.addEventListener("click", () => eqSetMode("wx"));

  const rxBtn = document.getElementById("eq-mode-rx");
  if (rxBtn) rxBtn.addEventListener("click", () => eqSetMode("rx"));

  const runBtn = document.getElementById("eq-run-cmd-btn");
  if (runBtn) {
    runBtn.addEventListener("click", async () => {
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
  }

  const copyBtn = document.getElementById("eq-copy-raw-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", () => {
      document.getElementById("eq-raw-cmd").value = document.getElementById("eq-preview-box").textContent.trim();
    });
  }

  const clearLogBtn = document.getElementById("eq-clear-log-btn");
  if (clearLogBtn) {
    clearLogBtn.addEventListener("click", () => {
      const log = document.getElementById("eq-log");
      if (log) log.innerHTML = "";
    });
  }
}

PAGE_INIT.equipment = function () {
  eqSetStatusPill("offline");
  eqBuildJobButtons();
  eqWirePageControls();
  eqLoadCommands();
  eqPollStatus();
  EQ.pollTimer = setInterval(eqPollStatus, 1500);
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
      } else if (u.id !== CURRENT_USER.id && u.role !== "admin") {
        actions.push(`
          <select class="role-select" data-user-id="${u.id}">
            <option value="operator" ${u.role === "operator" ? "selected" : ""}>Operator</option>
            <option value="machine_controller" ${u.role === "machine_controller" ? "selected" : ""}>Machine Controller</option>
            <option value="engineer" ${u.role === "engineer" ? "selected" : ""}>Engineer</option>
          </select>
          <button class="btn btn-sm" onclick="userChangeRole(${u.id})">Save</button>`);
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

async function userChangeRole(id) {
  const select = document.querySelector(`.role-select[data-user-id="${id}"]`);
  if (!select) return;
  const res = await apiFetch(`/api/users/${id}/role`, {
    method: "PATCH",
    body: JSON.stringify({ role: select.value }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    showToast(data.error || "Could not update role.");
    return;
  }
  showToast("Role updated.", "success");
  const activeFilter = document.querySelector(".user-filter-bar button.active");
  userFetchAndRender(activeFilter ? activeFilter.dataset.filter : "pending");
}
window.userChangeRole = userChangeRole;

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
