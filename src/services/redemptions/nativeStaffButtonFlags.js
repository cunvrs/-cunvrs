// CUNVRS_SERVER_SIDE_STAFF_FLAGS_V1
export function assertNativeStaffButtonsEnabled(action) {
  if (
    process.env.CUNVRS_REDEMPTIONS_ENABLED !== 'true' ||
    process.env.CUNVRS_REDEMPTION_STAFF_BUTTONS_ENABLED !== 'true'
  ) {
    throw new Error('Redemption staff buttons are disabled.');
  }

  if (
    action === 'close' &&
    process.env.CUNVRS_REDEMPTION_DELETION_ENABLED !== 'true'
  ) {
    throw new Error('Native ticket closing is disabled.');
  }
}
