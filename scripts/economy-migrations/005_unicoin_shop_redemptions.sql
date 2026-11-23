BEGIN;

-- Shop purchases use Unicoins and have no Shop Token type.
ALTER TABLE cunvrs_redemptions ALTER COLUMN ticket_type DROP NOT NULL;

COMMIT;
