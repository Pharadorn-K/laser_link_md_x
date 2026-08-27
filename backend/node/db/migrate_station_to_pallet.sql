-- Migrate an existing database created with station_no ENUM('Station1', 'Station2').
-- Back up the database before running this migration.

USE laser_link_md_x;

-- Keep the old enum values temporarily so existing rows can be renamed.
ALTER TABLE model_condition
    CHANGE COLUMN station_no pallet_no
    ENUM('Station1', 'Station2', 'Pallet1', 'Pallet2')
    NOT NULL DEFAULT 'Station1';

UPDATE model_condition
SET pallet_no = CASE pallet_no
    WHEN 'Station1' THEN 'Pallet1'
    WHEN 'Station2' THEN 'Pallet2'
    ELSE pallet_no
END;

-- Remove the old enum values after all rows have been converted.
ALTER TABLE model_condition
    MODIFY COLUMN pallet_no
    ENUM('Pallet1', 'Pallet2')
    NOT NULL DEFAULT 'Pallet1';

-- The old unique index name is harmless, but this gives it the current name.
ALTER TABLE model_condition
    RENAME INDEX uq_job_station TO uq_job_pallet;