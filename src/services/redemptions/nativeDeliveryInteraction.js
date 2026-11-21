import { assertNativeStaffButtonsEnabled } from './nativeStaffButtonFlags.js';
﻿import { ChannelType, MessageFlags } from 'discord.js';

import {
  buildNativeDeliveryModal,
  DELIVERY_MODAL_PREFIX,
  DELIVERY_EVIDENCE_ID
} from './nativeDeliveryModal.js';

import {
  REDEMPTION_SELECT_PREFIX
} from './nativeRedemptionSelectMenu.js';

import {
  listNativeTicketRedemptions
} from './nativeRedemptionSelection.js';

import {
  requireRedemptionStaffAccess
} from './redemptionStaffAuth.js';

import {
  REDEMPTION_TICKET_CONFIG
} from './ticketConfig.js';

import {
  transitionRedemption
} from './redemptionService.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function checkDeliveryAccess(interaction) {
  assertNativeStaffButtonsEnabled("deliver");
  if (process.env.CUNVRS_REDEMPTIONS_ENABLED !== 'true') {
    throw new Error('Redemptions are disabled.');
  }

  requireRedemptionStaffAccess(interaction, 'deliver');

  if (
    !interaction.guildId ||
    !interaction.channelId ||
    interaction.channel?.id !== interaction.channelId ||
    interaction.channel?.type !== ChannelType.GuildText ||
    interaction.channel?.parentId !== REDEMPTION_TICKET_CONFIG.categoryId
  ) {
    throw new Error('Not a native redemption ticket.');
  }
}

export async function handleNativeDeliverySelection(interaction) {
  if (
    interaction.customId !==
    `${REDEMPTION_SELECT_PREFIX}deliver`
  ) {
    return false;
  }

  try {
    checkDeliveryAccess(interaction);

    if (
      !Array.isArray(interaction.values) ||
      interaction.values.length !== 1 ||
      typeof interaction.values[0] !== 'string' ||
      !UUID.test(interaction.values[0])
    ) {
      throw new Error('Invalid delivery selection.');
    }

    // Modal must be the initial response to this interaction.
    // Database ownership will be rechecked on submission.
    await interaction.showModal(
      buildNativeDeliveryModal(interaction.values[0])
    );

  } catch (error) {
    console.error('[native delivery selection]', error.message);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '♡ unable to open the delivery form.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] }
      }).catch(() => {});
    }
  }

  return true;
}

export async function handleNativeDeliverySubmission(
  interaction,
  options = {}
) {
  if (
    typeof interaction.customId !== 'string' ||
    !interaction.customId.startsWith(DELIVERY_MODAL_PREFIX)
  ) {
    return false;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  try {
    checkDeliveryAccess(interaction);

    const redemptionId =
      interaction.customId.slice(DELIVERY_MODAL_PREFIX.length);

    if (!UUID.test(redemptionId)) {
      throw new Error('Invalid redemption ID.');
    }

    const evidence = interaction.fields.getTextInputValue(
      DELIVERY_EVIDENCE_ID
    );

    if (
      typeof evidence !== 'string' ||
      evidence.trim().length < 8 ||
      evidence.length > 500
    ) {
      throw new Error('Invalid fulfillment evidence.');
    }

    const eligible = await listNativeTicketRedemptions(
      interaction,
      'deliver',
      options
    );

    const record = eligible.find(
      row => row.id.toLowerCase() === redemptionId.toLowerCase()
    );

    if (!record) {
      throw new Error(
        'Redemption is no longer eligible in this ticket.'
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
      action: 'deliver',
      fulfillmentEvidence: evidence.trim()
    });

    if (!result.success) {
      await interaction.editReply({
        content: '♡ delivery was not completed. Please review the request.',
        allowedMentions: { parse: [] }
      });

      return true;
    }

    await interaction.editReply({
      content:
        '## 🎀 ⋮ delivery recorded!\n\n' +
        `♡ **status:** ${result.status}\n` +
        `♡ **request:** \`${record.id}\`\n\n` +
        '-# Fulfillment evidence saved with the redemption.',
      allowedMentions: { parse: [] }
    });

  } catch (error) {
    console.error('[native delivery submission]', error.message);

    await interaction.editReply({
      content:
        '♡ unable to complete delivery. ' +
        'Please verify the request and try again.',
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }

  return true;
}
