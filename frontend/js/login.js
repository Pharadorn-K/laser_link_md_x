// frontend/js/login.js
// ============================================================
// login.js — sign in / sign up screen
// ============================================================
const API_BASE = ""; // same-origin (Node gateway serves this file too)

// ---------------- COMMON: tab switching + alert helper ----------------
const tabs = document.querySelectorAll(".login-tab");
const forms = document.querySelectorAll(".login-form");
const alertBox = document.getElementById("alert-box");

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("active"));
    forms.forEach((f) => f.classList.remove("active"));
    tab.classList.add("active");
    document.querySelector(`.login-form[data-tab="${tab.dataset.tab}"]`).classList.add("active");
    clearAlert();
  });
});

function showAlert(message, type = "error") {
  alertBox.innerHTML = `<div class="alert alert-${type}">${escapeHtml(message)}</div>`;
}
function clearAlert() {
  alertBox.innerHTML = "";
}
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ---------------- FOR SIGN IN ----------------
const signinForm = document.getElementById("signin-form");
signinForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert();

  const employee_id = document.getElementById("si-employee-id").value.trim();
  const password = document.getElementById("si-password").value;

  try {
    const res = await fetch(`${API_BASE}/api/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employee_id, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      showAlert(data.error || "Sign in failed.");
      return;
    }
    localStorage.setItem("nlm_token", data.token);
    localStorage.setItem("nlm_user", JSON.stringify(data.user));
    window.location.href = "index.html";
  } catch (err) {
    showAlert("Could not reach the server. Please try again.");
  }
});

// ---------------- FOR SIGN UP ----------------
const photoInput = document.getElementById("su-photo");
const photoPreview = document.getElementById("su-photo-preview");
photoInput.addEventListener("change", () => {
  const file = photoInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => (photoPreview.src = e.target.result);
  reader.readAsDataURL(file);
});

const signupForm = document.getElementById("signup-form");
signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert();

  const name = document.getElementById("su-name").value.trim();
  const employee_id = document.getElementById("su-employee-id").value.trim();
  const password = document.getElementById("su-password").value;
  const password2 = document.getElementById("su-password2").value;

  if (password !== password2) {
    showAlert("Passwords do not match.");
    return;
  }

  const fd = new FormData();
  fd.append("name", name);
  fd.append("employee_id", employee_id);
  fd.append("password", password);
  if (photoInput.files[0]) fd.append("photo", photoInput.files[0]);

  try {
    const res = await fetch(`${API_BASE}/api/auth/signup`, { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) {
      showAlert(data.error || "Sign up failed.");
      return;
    }
    showAlert("Account created. Please wait for admin approval before signing in.", "success");
    signupForm.reset();
    photoPreview.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3C/svg%3E";
    tabs[0].click();
  } catch (err) {
    showAlert("Could not reach the server. Please try again.");
  }
});

// ---------------- If already signed in, skip straight to the app ----------------
if (localStorage.getItem("nlm_token")) {
  window.location.href = "index.html";
}
