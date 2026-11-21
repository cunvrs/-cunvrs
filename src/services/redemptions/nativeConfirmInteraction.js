import { MessageFlags } from 'discord.js';

import {
  REDEMPTION_CONFIRM_PREFIX,
  REDEMPTION_CANCEL_ID
} from './nativeRedemptionConfirmation.js';

import {
  listNativeTicketRedemptions
} from './nativeRedemptionSelection.js';

import {
  transitionRedemption
} from './redemptionService.js';

const CONFIRM_PATTERN =
  /^cunvrs_redemption_confirm_(approve|decline)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export async function handleNativeRedemptionConfirmation(
  interaction,
  options = {}
) {
  if (interaction.customId === REDEMPTION_CANCEL_ID) {
    await interaction.update({
      content: '♡ redemption action cancelled. No changes made.',
      components: [],
      allowedMentions: { parse: [] }
    });

    return true;
  }

  if (
    typeof interaction.customId !== 'string' ||
    !interaction.customId.startsWith(REDEMPTION_CONFIRM_PREFIX)
  ) {
    return false;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  try {
    const match = interaction.customId.match(CONFIRM_PATTERN);

    if (!match) {
      throw new Error('Invalid confirmation.');
    }

    const action = match[1].toLowerCase();
    const redemptionId = match[2].toLowerCase();

    // The lookup rechecks feature flag, manager permissions,
    // native ticket ownership and eligible status.
    const records = await listNativeTicketRedemptions(
      interaction,
      action,
      options
    );

    const record = records.find(
      row => row.id.toLowerCase() === redemptionId
    );

    if (!record) {
      throw new Error(
        'Request is no longer eligible in this ticket.'
      );
    }

    const runTransition =
      options.transition ?? transitionRedemption;

    const result = await runTransition({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      redemptionId: record.id,
      staffId: interaction.user.id,
      staffAuthorized: true,
      action
    });

    if (!result.success) {
      await interaction.editReply({
        content:
          `♡ redemption was not updated: ${result.reason}`,
        allowedMentions: { parse: [] }
      });

      return true;
    }

    await interaction.editReply({
      content:
        '## 🎀 ⋮ redemption updated!\n\n' +
        `♡ **action:** ${action}\n` +
        `♡ **status:** ${result.status}\n` +
        `♡ **request:** \`${record.id}\``,
      allowedMentions: { parse: [] }
    });

  } catch (error) {
    console.error(
      '[native redemption confirmation]',
      error.message
    );

    await interaction.editReply({
      content:
        '♡ unable to process this confirmation. ' +
        'Please check the request and try again.',
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }

  return true;
}
