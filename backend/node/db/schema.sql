-- backend/node/db/schema.sql
-- ============================================================
-- laser_link_md_x database schema
-- ============================================================
CREATE DATABASE IF NOT EXISTS laser_link_md_x
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE laser_link_md_x;

-- ------------------------------------------------------------
-- users
--   Sign-up requires: photo (optional), name, employee_id, password.
--   Account starts as status='pending' and cannot sign in until an
--   admin sets status='approved' (see PATCH /api/users/:id/approve).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    employee_id   VARCHAR(32)  NOT NULL UNIQUE,
    name          VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    photo_path    VARCHAR(255) DEFAULT NULL,
    role          ENUM('admin', 'user') NOT NULL DEFAULT 'user',
    status        ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Seed a default admin so someone can log in and approve the rest.
-- Employee ID: admin  /  Password: Admin@123  (CHANGE THIS after first login)
-- Hash below is a bcrypt hash generated for 'Admin@123' — replace via signup
-- flow in production; this is only a convenience bootstrap row.
INSERT INTO users (employee_id, name, password_hash, role, status)
SELECT 'admin', 'System Administrator',
       '$2a$10$dqkQRUQ58UQqbykrNlxmG.2kxv.qYldehyWPwPAmDGVYvop2rHiW6',
       'admin', 'approved'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE employee_id = 'admin');

-- ------------------------------------------------------------
-- model_condition
--   Backs the Model Set page. One row = one (model, job_no,
--   pallet) marking condition. c1/b1, c2/b2, c3/b3 are three
--   fixed "CharacterString @ BLK" slots — the Model Set UI's
--   "Add Condition" button reveals them one at a time. Extending
--   past 3 slots requires an ALTER TABLE + matching UI change.
--
--   The base laser command for a row is built as:
--     JobNo=<job_no zero-padded to 4>
--     ,BLK=<bN zero-padded to 3>,CharacterString=<cN>   (repeated for each non-null pair)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS model_condition (
    id                 INT AUTO_INCREMENT PRIMARY KEY,
    model              VARCHAR(255) NOT NULL,
    job_no             SMALLINT NOT NULL,
    pallet_no         ENUM('Pallet1', 'Pallet2') NOT NULL DEFAULT 'Pallet1',
    check_read2dcode   BOOLEAN NOT NULL DEFAULT TRUE,
    check_grade2dcode  BOOLEAN NOT NULL DEFAULT TRUE,
    control_grade      VARCHAR(100) NULL DEFAULT NULL,
    check_camera       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_job_pallet (job_no, pallet_no)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- model_condition_item
--   One row per "CharacterString @ BLK" condition on a model.
--   Replaces the old fixed c1/b1, c2/b2, c3/b3 columns with an
--   unbounded child table. UI enforces a soft cap (MAX_CONDITIONS
--   in model.controller.js, currently 20) — the schema itself has
--   no limit.
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

ALTER TABLE model_condition
  ADD COLUMN check_start2dcode BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN start2dcode_params JSON NULL DEFAULT NULL,
  ADD COLUMN read2dcode_detailed VARCHAR(4) NOT NULL DEFAULT '0';

  -- Lot No. — fixed-name condition (like a condition, but singular per model
-- and name can never change). Operators edit lot_no the same way they edit
-- other condition values; only admins toggle it on/off or move its BLK.
ALTER TABLE model_condition
  ADD COLUMN check_lot_no BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN lot_no VARCHAR(255) NULL DEFAULT NULL,
  ADD COLUMN lot_no_block SMALLINT NULL DEFAULT NULL;

-- Monitor page: one row per completed part (the "count part" trick),
-- used to build production history / traceability by lot.
CREATE TABLE IF NOT EXISTS production_log (
    id        INT AUTO_INCREMENT PRIMARY KEY,
    model     VARCHAR(255) NOT NULL,
    job_no    SMALLINT NOT NULL,
    pallet_no ENUM('Pallet1', 'Pallet2') NOT NULL,
    lot_no    VARCHAR(255) NULL DEFAULT NULL,
    count     INT NOT NULL,
    marked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE INDEX idx_production_log_pallet ON production_log (pallet_no, marked_at);

-- Lot No. is now mandatory on every model (see migrate_lotno_and_photo.sql
-- for the equivalent migration on existing databases).
ALTER TABLE model_condition
  MODIFY COLUMN lot_no VARCHAR(255) NOT NULL,
  MODIFY COLUMN lot_no_block SMALLINT NOT NULL DEFAULT 0,
  MODIFY COLUMN check_lot_no BOOLEAN NOT NULL DEFAULT TRUE;

-- Optional part photo shown on the Model Setting page.
ALTER TABLE model_condition
  ADD COLUMN photo_path VARCHAR(255) NULL DEFAULT NULL;

ALTER TABLE model_condition
  MODIFY COLUMN lot_no VARCHAR(255) NOT NULL,
  MODIFY COLUMN lot_no_block SMALLINT NULL DEFAULT NULL,
  MODIFY COLUMN check_lot_no BOOLEAN NOT NULL DEFAULT TRUE;