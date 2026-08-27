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
--   station) marking condition. c1/b1, c2/b2, c3/b3 are three
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
    station_no         ENUM('Station1', 'Station2') NOT NULL DEFAULT 'Station1',
    check_read2dcode   BOOLEAN NOT NULL DEFAULT TRUE,
    check_grade2dcode  BOOLEAN NOT NULL DEFAULT TRUE,
    control_grade      VARCHAR(100) NULL DEFAULT NULL,
    check_camera       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_job_station (job_no, station_no)
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