-- backend/node/db/schema.sql
-- ============================================================
-- laser_link_md_x database schema — CONSOLIDATED
--
-- This file has been rewritten so that every column that used to
-- arrive later via a follow-up ALTER TABLE is now part of the base
-- CREATE TABLE statement below. Running this against a fresh MySQL
-- instance produces a database that matches the current app exactly
-- — no migration files need to be run afterward.
--
-- If you already have a running database that was built from the
-- old, non-consolidated version of this file, DO NOT re-run this
-- file against it — it will fail on "table already exists" and
-- duplicate-column errors. Your existing DB already has every
-- column below (that's what all those old ALTER TABLE statements
-- did to it). This file is only for provisioning a brand-new
-- database (fresh install, new environment, CI, etc).
-- ============================================================

CREATE DATABASE IF NOT EXISTS laser_link_md_x
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE laser_link_md_x;
SET SQL_SAFE_UPDATES = 0;

-- ------------------------------------------------------------
-- users
--   Sign-up requires: photo (optional), name, employee_id, password,
--   and a role — operator / machine_controller / engineer only
--   ('admin' is never selectable via signup; see the bootstrap seed
--   row below). Account starts as status='pending' and cannot sign
--   in until an admin sets status='approved'
--   (PATCH /api/users/:id/status).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    employee_id   VARCHAR(32)  NOT NULL UNIQUE,
    name          VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    photo_path    VARCHAR(255) DEFAULT NULL,
    role          ENUM('admin', 'operator', 'machine_controller', 'engineer')
                  NOT NULL DEFAULT 'operator',
    status        ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Seed a default admin so someone can log in and approve everyone
-- else. Employee ID: admin / Password: Admin@123
-- CHANGE THIS PASSWORD after first login (Profile page).
INSERT INTO users (employee_id, name, password_hash, role, status)
SELECT 'admin', 'System Administrator',
       '$2a$10$dqkQRUQ58UQqbykrNlxmG.2kxv.qYldehyWPwPAmDGVYvop2rHiW6',
       'admin', 'approved'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE employee_id = 'admin');

-- ------------------------------------------------------------
-- model_condition
--   Backs the Model Setting / Add New Model pages. One row = one
--   (model, job_no, pallet) marking condition/recipe.
--
--   Value parameters ("CharacterString @ BLK") live in the child
--   table model_condition_item below — an unbounded list instead of
--   fixed columns (soft-capped at MAX_CONDITIONS, currently 20, in
--   model.controller.js).
--
--   Lot No. is its own fixed-name pseudo-condition: mandatory on
--   every model (check_lot_no defaults TRUE, lot_no is NOT NULL),
--   edited the same way as any other condition value, but its name
--   can never change. lot_no_block is nullable because Lot No. is
--   tracked for traceability even on models where it isn't
--   physically marked on the part.
--
--   check_start2dcode / start2dcode_params drive WX,Check2DCode5
--   (17 positional parameters, A-Q, stored as a JSON array).
--   check_read2dcode / read2dcode_detailed drive
--   RX,CodeReadResult=<0|1>. check_grade2dcode + control_grade gate
--   the 2D-code grade check. check_camera toggles the camera-check
--   step in every sequence (manual Start Marking, AUTO1-2, and the
--   single-pallet AUTO1/AUTO2 loop).
--
--   photo_path is an optional reference part photo
--   (uploads/models/...).
--
--   The base laser command for a row is built client-side as:
--     JobNo=<job_no zero-padded to 4>
--     ,BLK=<bN zero-padded to 3>,CharacterString=<cN>   (repeated per condition)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS model_condition (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    model               VARCHAR(255) NOT NULL,
    job_no              SMALLINT NOT NULL,
    pallet_no           ENUM('Pallet1', 'Pallet2') NOT NULL DEFAULT 'Pallet1',
    check_start2dcode   BOOLEAN NOT NULL DEFAULT FALSE,
    start2dcode_params  JSON NULL DEFAULT NULL,
    check_read2dcode    BOOLEAN NOT NULL DEFAULT TRUE,
    read2dcode_detailed VARCHAR(4) NOT NULL DEFAULT '0',
    check_grade2dcode   BOOLEAN NOT NULL DEFAULT TRUE,
    control_grade       VARCHAR(100) NULL DEFAULT NULL,
    check_camera        BOOLEAN NOT NULL DEFAULT TRUE,
    check_lot_no        BOOLEAN NOT NULL DEFAULT TRUE,
    lot_no              VARCHAR(255) NOT NULL,
    lot_no_block        SMALLINT NULL DEFAULT NULL,
    photo_path          VARCHAR(255) NULL DEFAULT NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_job_pallet (job_no, pallet_no)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- model_condition_item
--   One row per "CharacterString @ BLK" value condition on a model.
--   (Lot No. is NOT stored here — see the dedicated lot_no /
--   lot_no_block columns on model_condition above.)
--   Soft cap enforced in app code (MAX_CONDITIONS in
--   model.controller.js, currently 20) — the schema itself has no
--   hard limit.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS model_condition_item (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    model_condition_id  INT NOT NULL,
    condition_name      VARCHAR(255) NOT NULL,
    condition_value     VARCHAR(255) NOT NULL,
    block_no            SMALLINT NOT NULL,
    sort_order          SMALLINT NOT NULL DEFAULT 0,
    CONSTRAINT fk_mci_model_condition FOREIGN KEY (model_condition_id)
        REFERENCES model_condition(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE INDEX idx_mci_condition_name ON model_condition_item (condition_name);
CREATE INDEX idx_mci_model_condition_id ON model_condition_item (model_condition_id);

-- ------------------------------------------------------------
-- production_log
--   Append-only. One row per completed part (the "count part"
--   trick) — drives the running Count Part display on Monitor,
--   traceability by lot, and the Production Log page. NEVER edited
--   or deleted; production_count_reset (below) is what makes
--   "Reset count" / "Complete Setting" possible without losing
--   history.
--
--   type: 'setting' (admin / engineer / machine_controller, during
--   the Setting phase) vs 'mass' (operator, during Mass Production)
--   — driven purely by the acting user's role at insert time.
--
--   conditions: a JSON snapshot of that model's condition_name /
--   condition_value / block_no at the moment this part was counted,
--   so later edits to the model don't rewrite history.
--
--   code2d_result: 'R' = Pass, 'T' = Fail, 'S' = Skipped (both 2D
--   checks disabled for this model); NULL when no 2D check applies
--   or no result has been computed yet.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_log (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    model               VARCHAR(255) NOT NULL,
    job_no              SMALLINT NOT NULL,
    pallet_no           ENUM('Pallet1', 'Pallet2') NOT NULL,
    model_condition_id  INT NULL DEFAULT NULL,
    lot_no              VARCHAR(255) NULL DEFAULT NULL,
    count               INT NOT NULL,
    user_id             INT NULL DEFAULT NULL,
    employee_id         VARCHAR(32) NULL DEFAULT NULL,
    user_name           VARCHAR(100) NULL DEFAULT NULL,
    user_role           VARCHAR(32) NULL DEFAULT NULL,
    type                ENUM('mass', 'setting') NOT NULL DEFAULT 'setting',
    conditions          JSON NULL DEFAULT NULL,
    code2d_result       ENUM('R', 'S', 'T') NULL DEFAULT NULL,
    marked_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE INDEX idx_production_log_pallet ON production_log (pallet_no, marked_at);
CREATE INDEX idx_production_log_model_lot ON production_log (model_condition_id, lot_no);
CREATE INDEX idx_production_log_user ON production_log (user_id);

-- ------------------------------------------------------------
-- production_count_reset
--   Per (model_condition_id, lot_no): where the DISPLAYED running
--   count restarts from, without touching production_log history.
--   Displayed count = base_count + COUNT(production_log rows with
--   marked_at > reset_at) for that model_condition_id + lot_no.
--
--   reset_reason:
--     'manual_reset'     — plain "Reset count" button on Monitor.
--                           base_count = 0.
--     'setting_complete' — the "Complete Setting" flow. base_count =
--                           whatever count the admin / engineer /
--                           machine controller entered as parts
--                           already used for setting/testing. This
--                           is also the flag that
--                           production.controller.js's
--                           isSettingComplete() checks, to gate
--                           operators from starting Mass Production
--                           before Setting has been completed at
--                           least once for that model/lot.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_count_reset (
    model_condition_id INT NOT NULL,
    lot_no             VARCHAR(255) NOT NULL,
    reset_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reset_by_user_id   INT NULL DEFAULT NULL,
    base_count         INT NOT NULL DEFAULT 0,
    reset_reason       ENUM('manual_reset', 'setting_complete') NOT NULL DEFAULT 'manual_reset',
    PRIMARY KEY (model_condition_id, lot_no)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- production_goal
--   One shared production target per (model, lot_no) — keyed this
--   way (not per model_condition_id) so AUTO1-2 pallets, which run
--   the same model on two different job_no's, naturally share ONE
--   combined goal. Each pallet's Monitor card fetches and displays
--   progress against this same row independently
--   (see monRefreshGoal() / monRefreshGoals() in dashboard.js).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_goal (
    model          VARCHAR(255) NOT NULL,
    lot_no         VARCHAR(255) NOT NULL,
    goal_count     INT NOT NULL,
    set_by_user_id INT NULL DEFAULT NULL,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (model, lot_no)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- system_log
--   Central audit trail. Every controller action that changes state
--   (model create/edit/delete, sign-in/up/out, user approvals/role
--   changes, work-mode changes, equipment commands, production
--   goal set/clear, setting-complete, count reset, continue-lot)
--   calls systemLog.service.js's logAction(), which writes one row
--   here. Logging failures are swallowed inside the service so a
--   broken log write never breaks the real request.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_log (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    user_id       INT NULL DEFAULT NULL,
    employee_id   VARCHAR(32)  NULL DEFAULT NULL,
    user_name     VARCHAR(100) NULL DEFAULT NULL,
    user_role     VARCHAR(32)  NULL DEFAULT NULL,
    action        VARCHAR(64)  NOT NULL,
    target_type   VARCHAR(64)  NULL DEFAULT NULL,
    target_id     VARCHAR(64)  NULL DEFAULT NULL,
    description   VARCHAR(500) NULL DEFAULT NULL,
    details       JSON NULL DEFAULT NULL,
    status        ENUM('success', 'failed') NOT NULL DEFAULT 'success',
    ip_address    VARCHAR(64) NULL DEFAULT NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE INDEX idx_system_log_created_at ON system_log (created_at);
CREATE INDEX idx_system_log_action     ON system_log (action);
CREATE INDEX idx_system_log_user       ON system_log (user_id);
