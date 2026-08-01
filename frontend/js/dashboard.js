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
  home: "Home",
  model_set: "Model Set",
  manual: "Manual",
  alarm_center: "Alarm Center",
  equipment: "Equipment",
  profile: "Profile",
  user: "Users",
};

// Per-page init hooks, filled in by each section below.
const PAGE_INIT = {};
// Per-page teardown hooks (e.g. stop polling) when navigating away.
const PAGE_TEARDOWN = {};

let activePage = null;

async function loadPage(page) {
  if (page === "equipment" || page === "user") {
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
  loadPage("home");
}

document.addEventListener("DOMContentLoaded", bootstrap);

/* ============================================================
   FOR HOME PAGE — placeholder, nothing to initialize yet
   ============================================================ */
PAGE_INIT.home = function () {};

/* ============================================================
   FOR MODEL SET / MANUAL / ALARM CENTER — placeholders
   ============================================================ */
PAGE_INIT.model_set = function () {};
PAGE_INIT.manual = function () {};
PAGE_INIT.alarm_center = function () {};

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

PAGE_INIT.user = function () {
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
