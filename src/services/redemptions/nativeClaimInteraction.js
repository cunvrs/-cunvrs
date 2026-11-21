import { MessageFlags } from 'discord.js';

import {
  claimNativeRedemptionTicket
} from './nativeTicketClaims.js';

import {
  REDEMPTION_STAFF_BUTTONS
} from './redemptionStaffControls.js';

export async function handleNativeRedemptionClaim(
  interaction,
  options = {}
) {
  if (interaction.customId !== REDEMPTION_STAFF_BUTTONS.claim) {
    return false;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  try {
    const result = await claimNativeRedemptionTicket(
      interaction,
      options
    );

    const content = result.claimed
      ? '## Ticket claimed!\n\n' +
        `Assigned staff: <@${result.claimedBy}>`
      : '## Ticket already claimed!\n\n' +
        `Assigned staff: <@${result.claimedBy}>`;

    await interaction.editReply({
      content,
      allowedMentions: { parse: [] }
    });

  } catch (error) {
    console.error(
      '[native redemption claim]',
      error
    );

    await interaction.editReply({
      content:
        'Unable to claim this ticket. ' +
        'Please check your permissions or contact a manager.',
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }

  return true;
}
