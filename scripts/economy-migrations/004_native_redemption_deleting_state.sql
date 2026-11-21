-- Add an exclusive deleting state for native redemption tickets.
-- Apply to cunvrs_restore_test before production review.

BEGIN;

ALTER TABLE cunvrs_native_redemption_closures
  DROP CONSTRAINT IF EXISTS
  cunvrs_native_redemption_closures_state_check;

ALTER TABLE cunvrs_native_redemption_closures
  ADD CONSTRAINT
  cunvrs_native_redemption_closures_state_check
  CHECK (
    state IN ('closing', 'archived', 'deleting', 'closed')
  );

COMMIT;
