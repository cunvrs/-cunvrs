import {
  REDEMPTION_STAFF_BUTTONS
} from './redemptionStaffControls.js';

import {
  listNativeTicketRedemptions
} from './nativeRedemptionSelection.js';

import {
  buildNativeRedemptionSelect
} from './nativeRedemptionSelectMenu.js';

const BUTTON_ACTIONS = Object.freeze({
  [REDEMPTION_STAFF_BUTTONS.approve]: 'approve',
  [REDEMPTION_STAFF_BUTTONS.decline]: 'decline',
  [REDEMPTION_STAFF_BUTTONS.deliver]: 'deliver'
});

export async function handleNativeRedemptionActionButton(
  interaction,
  options = {}
) {
  const action = BUTTON_ACTIONS[interaction.customId];

  if (!action) {
    return false;
  }

  await interaction.deferReply();

  try {
    const requests = await listNativeTicketRedemptions(
      interaction,
      action,
      options
    );

    const menu = buildNativeRedemptionSelect(
      action,
      requests
    );

    await interaction.editReply(menu);
  } catch (error) {
    console.error(
      '[native redemption action selection]',
      error
    );

    await interaction.editReply({
      content:
        '♡ unable to list redemption requests. ' +
        'Please check your permissions or contact a manager.',
      components: [],
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }

  return true;
}
