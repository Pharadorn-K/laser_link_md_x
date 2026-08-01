-- ============================================================
-- new-laser-marking database schema
-- ============================================================
CREATE DATABASE IF NOT EXISTS new_laser_marking
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE new_laser_marking;

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
