// frontend/js/i18n.js
// ============================================================
// Minimal offline i18n: localStorage-backed language switch,
// dictionary lookup, and a DOM-attribute-driven apply pass.
// No build step, no external calls — safe for the shop-floor IPC.
//
// Usage in HTML:
//   <span data-i18n="nav.monitor">Monitor</span>          -> textContent
//   <input data-i18n-placeholder="field.lotno_ph" />       -> placeholder
//   <button data-i18n-title="alarm.refresh">...</button>   -> title attr
//   <p data-i18n-html="ms.auto_footer_hint_html">...</p>   -> innerHTML (for strings with <strong> etc.)
//
// Usage in JS:
//   t("alarm.col.tag")            -> translated string, current language
//   I18N.applyTranslations(root)  -> re-run the attribute pass on a subtree
//     (call this after injecting any fragment HTML, e.g. after
//     content.innerHTML = await res.text() in dashboard.js)
// ============================================================
(function () {
  const LANG_KEY = "nlm_lang";
  const DEFAULT_LANG = "en";

  const STRINGS = {
    en: {
      // ---- common ----
      "common.signout": "Sign out",
      "common.refresh": "Refresh",
      "common.save": "Save",
      "common.cancel": "Cancel",
      "common.delete": "Delete",
      "common.add": "Add",
      "common.confirm_yes": "Yes, set it",
      "common.confirm_title": "Confirm change",

      // ---- nav ----
      "nav.section.overview": "Overview",
      "nav.monitor": "Monitor",
      "nav.section.marking": "Marking",
      "nav.model_setting": "Model Setting",
      "nav.add_new_model": "Add New Model",
      "nav.alarm_center": "Alarm Center",
      "nav.section.account": "Account",
      "nav.profile": "Profile",
      "nav.all_user": "All User",

      // ---- page titles (topbar) ----
      "page.title.monitor": "Monitor",
      "page.title.model_setting": "Model Setting",
      "page.title.add_new_model": "Add New Model",
      "page.title.alarm_center": "Alarm Center",
      "page.title.profile": "Profile",
      "page.title.all_user": "Users",

      // ---- login ----
      "login.tab.signin": "Sign in",
      "login.tab.signup": "Sign up",
      "login.brand.headline": "Job queueing and full command control for the MD‑X2520A.",
      "login.brand.desc": "Queue marking jobs, run any command from the full protocol reference, and keep a live log of everything sent to the marker — from one browser tab.",
      "login.brand.meta.protocol": "Protocol",
      "login.brand.meta.marker": "Marker",
      "login.brand.meta.access": "Access",
      "login.brand.meta.access_value": "Admin-approved accounts",
      "login.field.employee_id": "Employee ID",
      "login.field.password": "Password",
      "login.field.confirm_password": "Confirm password",
      "login.field.name": "Full name",
      "login.field.role": "Role",
      "login.field.photo": "Photo (optional)",
      "login.role.placeholder": "— select role —",
      "login.role.operator": "Operator",
      "login.role.machine_controller": "Machine Controller",
      "login.role.engineer": "Engineer",
      "login.btn.signin": "Sign in",
      "login.btn.signup": "Create account",
      "login.note.signin": "Only approved accounts can sign in. New accounts need admin approval first.",
      "login.note.signup": "An admin must approve your account before you can sign in.",

      // ---- alarm center ----
      "alarm.tab.current": "Current Alarms",
      "alarm.tab.history": "History Alarms",
      "alarm.refresh": "Refresh",
      "alarm.details_title": "Alarm Details & Instructions",
      "alarm.detail.empty": "Select an alarm from the list to see details and recovery steps.",
      "alarm.col.no": "#",
      "alarm.col.tag": "Tag",
      "alarm.col.source": "Source",
      "alarm.col.description": "Description",
      "alarm.col.severity": "Severity",
      "alarm.col.occurred": "Occurred",
      "alarm.col.resolved": "Resolved",
      "alarm.reset_btn": "Reset & Check Again",
      "alarm.checking": "Checking…",
      "alarm.attempts": "Attempts so far:",
      "alarm.resolved_after": "Resolved after",
      "alarm.what_to_do": "What to do",
      "alarm.resolution": "Resolution",
      "alarm.no_active": "No active alarms. All clear.",
      "alarm.no_history": "No alarm history yet.",

      // ---- profile ----
      "profile.edit_title": "Edit profile",
      "profile.field.photo": "Photo",
      "profile.field.name": "Full name",
      "profile.field.new_password": "New password",
      "profile.field.new_password_placeholder": "Leave blank to keep current password",
      "profile.save_btn": "Save changes",

      // ---- all user ----
      "users.filter.pending": "Pending",
      "users.filter.approved": "Approved",
      "users.filter.rejected": "Rejected",
      "users.filter.all": "All",
      "users.col.name": "Name",
      "users.col.employee_id": "Employee ID",
      "users.col.role": "Role",
      "users.col.status": "Status",
      "users.col.requested": "Requested",

      // ---- monitor ----
      "monitor.live_sequence": "Live Sequence",
      "monitor.manual_mode_title": "Manual Mode",
      "monitor.waiting_signal": "Waiting for signal",
      "monitor.2button_start": "2-Button Start",
      "monitor.manual_active": "Manual mode active.",
      "monitor.manual_desc": "Marking is triggered from the Model Setting page in manual mode. This page shows model details only — the 2‑hand start / auto sequence here is disabled.",
      "monitor.manual_pill": "Manual mode",
      "monitor.goto_model_setting": "Go to Model Setting",
      "monitor.pallet1": "Pallet 1",
      "monitor.pallet2": "Pallet 2",
      "monitor.no_model_p1": "No model selected for Pallet 1 — choose one on Model Setting.",
      "monitor.no_model_p2": "No model selected for Pallet 2 — choose one on Model Setting.",

      // ---- model setting ----
      "ms.pallet1": "Pallet 1",
      "ms.pallet2": "Pallet 2",
      "ms.work_mode": "Work Mode",
      "ms.select_mode_placeholder": "— select mode —",
      "ms.mode.manual": "MANUAL",
      "ms.mode.auto12": "AUTO 1-2 (both pallets)",
      "ms.mode.auto1": "AUTO 1 (Pallet 1 only)",
      "ms.mode.auto2": "AUTO 2 (Pallet 2 only)",
      "ms.set_mode_btn": "Set Mode",
      "ms.no_mode_active": "No mode active",
      "ms.select_mode_hint": "Select a mode above and click \"Set Mode\" to see its controls.",
      "ms.manual_control": "Manual Control",
      "ms.pallet_location_prefix": "Pallet in Operator Room:",
      "ms.start_marking_p1": "▶ Start Marking Pallet 1",
      "ms.start_marking_p2": "▶ Start Marking Pallet 2",
      "ms.start_hint": "Only the pallet currently in the Operator Room can start.",
      "ms.start_sequence": "Start Marking Sequence",
      "ms.output_log": "Output Log",
      "ms.clear": "Clear",
      "ms.auto_sequence": "Auto Sequence",
      "ms.interlock_note": "⚠ Interlock signals from equipment are not connected yet — this runs in simulation mode only.",
      "ms.auto_activation_note_html": "On <strong>Set</strong>: front door opens automatically, then you're taken to <strong>Monitor</strong> to push the 2‑hand start signal.",
      "ms.auto_footer_hint_html": "Live execution and the 2‑hand start button are on the <strong>Monitor</strong> page — a queued start's front door closes as soon as its cycle's turn comes up.",

      // ---- add new model ----
      "anm.mode.add": "+ Add Model",
      "anm.mode.editp1": "Edit Model P1",
      "anm.mode.editp2": "Edit Model P2",
      "anm.select_model": "Select model",
      "anm.select_placeholder": "— select —",
      "anm.edit_empty": "Select a model above to edit its condition.",
      "anm.add_btn": "Add Model",
      "anm.save_btn": "Save Changes",
      "field.model": "Model",
      "field.jobno": "Job No. (0-1999)",
      "field.pallet": "Pallet",
      "field.photo_optional": "Part photo (optional)",
      "field.lotno": "Lot No. (starting value)",
      "ms.lotno_hint": "Lot No. isn't marked on the part — it's only recorded when a part is counted, so it can be used to filter production history later. Update its value from the Monitor or Model Setting pallet card, the same way you update conditions, every 150 parts or less.",
      "ms.grade2d_label": "Check Grade 2D Code",
      "ms.control_grade": "Control Grade",
      "ms.check_camera": "Check Camera",
      "ms.conditions_title": "Conditions",
      "ms.add_condition_btn": "+ Add Condition",
      "ms.conditions_hint": "Each condition marks one CharacterString at one BLK No.",
      "ms.delete_btn": "Delete",
    },

    th: {
      // ---- common ----
      "common.signout": "ออกจากระบบ",
      "common.refresh": "รีเฟรช",
      "common.save": "บันทึก",
      "common.cancel": "ยกเลิก",
      "common.delete": "ลบ",
      "common.add": "เพิ่ม",
      "common.confirm_yes": "ใช่ ตั้งค่า",
      "common.confirm_title": "ยืนยันการเปลี่ยนแปลง",

      // ---- nav ----
      "nav.section.overview": "ภาพรวม",
      "nav.monitor": "มอนิเตอร์",
      "nav.section.marking": "การมาร์กชิ้นงาน",
      "nav.model_setting": "ตั้งค่ารุ่นชิ้นงาน",
      "nav.add_new_model": "เพิ่มรุ่นชิ้นงานใหม่",
      "nav.alarm_center": "ศูนย์แจ้งเตือน",
      "nav.section.account": "บัญชีผู้ใช้",
      "nav.profile": "โปรไฟล์",
      "nav.all_user": "ผู้ใช้ทั้งหมด",

      // ---- page titles (topbar) ----
      "page.title.monitor": "มอนิเตอร์",
      "page.title.model_setting": "ตั้งค่ารุ่นชิ้นงาน",
      "page.title.add_new_model": "เพิ่มรุ่นชิ้นงานใหม่",
      "page.title.alarm_center": "ศูนย์แจ้งเตือน",
      "page.title.profile": "โปรไฟล์",
      "page.title.all_user": "ผู้ใช้งาน",

      // ---- login ----
      "login.tab.signin": "เข้าสู่ระบบ",
      "login.tab.signup": "สมัครสมาชิก",
      "login.brand.headline": "จัดคิวงานมาร์กและควบคุมคำสั่งทั้งหมดของ MD‑X2520A",
      "login.brand.desc": "จัดคิวงานมาร์ก สั่งคำสั่งใดก็ได้จากรายการโปรโตคอลทั้งหมด และดูบันทึกการทำงานแบบสดของทุกคำสั่งที่ส่งไปยังเครื่องมาร์ก — จากแท็บเบราว์เซอร์เดียว",
      "login.brand.meta.protocol": "โปรโตคอล",
      "login.brand.meta.marker": "เครื่องมาร์ก",
      "login.brand.meta.access": "สิทธิ์การเข้าถึง",
      "login.brand.meta.access_value": "บัญชีที่ผ่านการอนุมัติจากผู้ดูแลระบบ",
      "login.field.employee_id": "รหัสพนักงาน",
      "login.field.password": "รหัสผ่าน",
      "login.field.confirm_password": "ยืนยันรหัสผ่าน",
      "login.field.name": "ชื่อ-นามสกุล",
      "login.field.role": "ตำแหน่ง",
      "login.field.photo": "รูปภาพ (ไม่บังคับ)",
      "login.role.placeholder": "— เลือกตำแหน่ง —",
      "login.role.operator": "ผู้ปฏิบัติงาน",
      "login.role.machine_controller": "ผู้ควบคุมเครื่องจักร",
      "login.role.engineer": "วิศวกร",
      "login.btn.signin": "เข้าสู่ระบบ",
      "login.btn.signup": "สร้างบัญชี",
      "login.note.signin": "เฉพาะบัญชีที่ได้รับอนุมัติเท่านั้นที่เข้าสู่ระบบได้ บัญชีใหม่ต้องรอผู้ดูแลระบบอนุมัติก่อน",
      "login.note.signup": "ผู้ดูแลระบบต้องอนุมัติบัญชีของคุณก่อนจึงจะเข้าสู่ระบบได้",

      // ---- alarm center ----
      "alarm.tab.current": "การแจ้งเตือนปัจจุบัน",
      "alarm.tab.history": "ประวัติการแจ้งเตือน",
      "alarm.refresh": "รีเฟรช",
      "alarm.details_title": "รายละเอียดและวิธีแก้ไข",
      "alarm.detail.empty": "เลือกการแจ้งเตือนจากรายการเพื่อดูรายละเอียดและขั้นตอนการแก้ไข",
      "alarm.col.no": "#",
      "alarm.col.tag": "แท็ก",
      "alarm.col.source": "แหล่งที่มา",
      "alarm.col.description": "รายละเอียด",
      "alarm.col.severity": "ระดับความรุนแรง",
      "alarm.col.occurred": "เวลาที่เกิด",
      "alarm.col.resolved": "เวลาที่แก้ไข",
      "alarm.reset_btn": "รีเซ็ตและตรวจสอบอีกครั้ง",
      "alarm.checking": "กำลังตรวจสอบ…",
      "alarm.attempts": "จำนวนครั้งที่ลอง:",
      "alarm.resolved_after": "แก้ไขแล้วภายใน",
      "alarm.what_to_do": "วิธีดำเนินการ",
      "alarm.resolution": "การแก้ไข",
      "alarm.no_active": "ไม่มีการแจ้งเตือน ทุกอย่างปกติ",
      "alarm.no_history": "ยังไม่มีประวัติการแจ้งเตือน",

      // ---- profile ----
      "profile.edit_title": "แก้ไขโปรไฟล์",
      "profile.field.photo": "รูปภาพ",
      "profile.field.name": "ชื่อ-นามสกุล",
      "profile.field.new_password": "รหัสผ่านใหม่",
      "profile.field.new_password_placeholder": "เว้นว่างไว้เพื่อใช้รหัสผ่านเดิม",
      "profile.save_btn": "บันทึกการเปลี่ยนแปลง",

      // ---- all user ----
      "users.filter.pending": "รออนุมัติ",
      "users.filter.approved": "อนุมัติแล้ว",
      "users.filter.rejected": "ปฏิเสธแล้ว",
      "users.filter.all": "ทั้งหมด",
      "users.col.name": "ชื่อ",
      "users.col.employee_id": "รหัสพนักงาน",
      "users.col.role": "ตำแหน่ง",
      "users.col.status": "สถานะ",
      "users.col.requested": "วันที่ขอสมัคร",

      // ---- monitor ----
      "monitor.live_sequence": "ลำดับการทำงานสด",
      "monitor.manual_mode_title": "โหมดควบคุมด้วยมือ",
      "monitor.waiting_signal": "รอสัญญาณ",
      "monitor.2button_start": "เริ่มด้วย 2 ปุ่ม",
      "monitor.manual_active": "เปิดใช้งานโหมดควบคุมด้วยมือ",
      "monitor.manual_desc": "การมาร์กจะถูกสั่งจากหน้าตั้งค่ารุ่นชิ้นงานเมื่ออยู่ในโหมดควบคุมด้วยมือ หน้านี้แสดงเฉพาะรายละเอียดรุ่นชิ้นงาน — ปุ่มเริ่ม 2 มือ/ลำดับอัตโนมัติที่นี่ถูกปิดใช้งาน",
      "monitor.manual_pill": "โหมดควบคุมด้วยมือ",
      "monitor.goto_model_setting": "ไปที่ตั้งค่ารุ่นชิ้นงาน",
      "monitor.pallet1": "พาเลท 1",
      "monitor.pallet2": "พาเลท 2",
      "monitor.no_model_p1": "ยังไม่ได้เลือกรุ่นชิ้นงานสำหรับพาเลท 1 — เลือกได้ที่หน้าตั้งค่ารุ่นชิ้นงาน",
      "monitor.no_model_p2": "ยังไม่ได้เลือกรุ่นชิ้นงานสำหรับพาเลท 2 — เลือกได้ที่หน้าตั้งค่ารุ่นชิ้นงาน",

      // ---- model setting ----
      "ms.pallet1": "พาเลท 1",
      "ms.pallet2": "พาเลท 2",
      "ms.work_mode": "โหมดการทำงาน",
      "ms.select_mode_placeholder": "— เลือกโหมด —",
      "ms.mode.manual": "ควบคุมด้วยมือ",
      "ms.mode.auto12": "อัตโนมัติ 1-2 (ทั้งสองพาเลท)",
      "ms.mode.auto1": "อัตโนมัติ 1 (เฉพาะพาเลท 1)",
      "ms.mode.auto2": "อัตโนมัติ 2 (เฉพาะพาเลท 2)",
      "ms.set_mode_btn": "ตั้งค่าโหมด",
      "ms.no_mode_active": "ยังไม่ได้ตั้งค่าโหมด",
      "ms.select_mode_hint": "เลือกโหมดด้านบนแล้วกด \"ตั้งค่าโหมด\" เพื่อดูตัวควบคุม",
      "ms.manual_control": "ควบคุมด้วยมือ",
      "ms.pallet_location_prefix": "พาเลทที่อยู่ในห้องผู้ปฏิบัติงาน:",
      "ms.start_marking_p1": "▶ เริ่มมาร์กพาเลท 1",
      "ms.start_marking_p2": "▶ เริ่มมาร์กพาเลท 2",
      "ms.start_hint": "เริ่มได้เฉพาะพาเลทที่อยู่ในห้องผู้ปฏิบัติงานขณะนี้เท่านั้น",
      "ms.start_sequence": "ลำดับการเริ่มมาร์ก",
      "ms.output_log": "บันทึกผลลัพธ์",
      "ms.clear": "ล้าง",
      "ms.auto_sequence": "ลำดับอัตโนมัติ",
      "ms.interlock_note": "⚠ ยังไม่ได้เชื่อมต่อสัญญาณ Interlock จากอุปกรณ์ — ทำงานในโหมดจำลองเท่านั้น",
      "ms.auto_activation_note_html": "เมื่อกด <strong>ตั้งค่า</strong>: ประตูหน้าจะเปิดอัตโนมัติ จากนั้นระบบจะพาไปที่ <strong>มอนิเตอร์</strong> เพื่อกดสัญญาณเริ่ม 2 มือ",
      "ms.auto_footer_hint_html": "การทำงานจริงและปุ่มเริ่ม 2 มืออยู่ที่หน้า <strong>มอนิเตอร์</strong> — ประตูหน้าของคิวที่รออยู่จะปิดทันทีที่ถึงรอบของมัน",

      // ---- add new model ----
      "anm.mode.add": "+ เพิ่มรุ่นชิ้นงาน",
      "anm.mode.editp1": "แก้ไขรุ่นชิ้นงาน P1",
      "anm.mode.editp2": "แก้ไขรุ่นชิ้นงาน P2",
      "anm.select_model": "เลือกรุ่นชิ้นงาน",
      "anm.select_placeholder": "— เลือก —",
      "anm.edit_empty": "เลือกรุ่นชิ้นงานด้านบนเพื่อแก้ไขเงื่อนไข",
      "anm.add_btn": "เพิ่มรุ่นชิ้นงาน",
      "anm.save_btn": "บันทึกการเปลี่ยนแปลง",
      "field.model": "รุ่นชิ้นงาน",
      "field.jobno": "หมายเลขงาน (0-1999)",
      "field.pallet": "พาเลท",
      "field.photo_optional": "รูปชิ้นงาน (ไม่บังคับ)",
      "field.lotno": "เลขล็อต (ค่าตั้งต้น)",
      "ms.lotno_hint": "เลขล็อตจะไม่ถูกมาร์กลงบนชิ้นงาน — จะถูกบันทึกเฉพาะตอนนับชิ้นงานเท่านั้น เพื่อใช้กรองประวัติการผลิตในภายหลัง อัปเดตค่าได้จากการ์ดพาเลทในหน้ามอนิเตอร์หรือตั้งค่ารุ่นชิ้นงาน เช่นเดียวกับการอัปเดตเงื่อนไข ทุก 150 ชิ้นหรือน้อยกว่านั้น",
      "ms.grade2d_label": "ตรวจสอบเกรดรหัส 2D",
      "ms.control_grade": "เกรดควบคุม",
      "ms.check_camera": "ตรวจสอบกล้อง",
      "ms.conditions_title": "เงื่อนไข",
      "ms.add_condition_btn": "+ เพิ่มเงื่อนไข",
      "ms.conditions_hint": "แต่ละเงื่อนไขจะมาร์กหนึ่ง CharacterString ที่หนึ่งหมายเลข BLK",
      "ms.delete_btn": "ลบ",
    },
  };

  function getLang() {
    return localStorage.getItem(LANG_KEY) || DEFAULT_LANG;
  }

  function setLang(lang) {
    localStorage.setItem(LANG_KEY, lang);
    document.documentElement.setAttribute("lang", lang);
  }

  function t(key, fallback) {
    const lang = getLang();
    const dict = STRINGS[lang] || STRINGS[DEFAULT_LANG];
    if (dict[key] !== undefined) return dict[key];
    if (STRINGS[DEFAULT_LANG][key] !== undefined) return STRINGS[DEFAULT_LANG][key];
    return fallback !== undefined ? fallback : key;
  }

  function applyTranslations(root) {
    root = root || document;
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    root.querySelectorAll("[data-i18n-html]").forEach((el) => {
      el.innerHTML = t(el.getAttribute("data-i18n-html"));
    });
    root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
    });
    root.querySelectorAll("[data-i18n-title]").forEach((el) => {
      el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
    });
    const toggleBtn = document.getElementById("lang-toggle-btn");
    if (toggleBtn) toggleBtn.textContent = getLang() === "en" ? "ไทย" : "EN";
  }

  function toggleLang() {
    setLang(getLang() === "en" ? "th" : "en");
    applyTranslations(document);
    document.dispatchEvent(new CustomEvent("i18n:changed", { detail: { lang: getLang() } }));
  }

  window.I18N = { t, getLang, setLang, applyTranslations, toggleLang };
  window.t = t; // shorthand for use in dashboard.js/login.js

  document.addEventListener("DOMContentLoaded", () => {
    document.documentElement.setAttribute("lang", getLang());
  });
})();