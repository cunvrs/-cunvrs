import { assertNativeStaffButtonsEnabled } from './nativeStaffButtonFlags.js';
﻿import { ChannelType } from 'discord.js';

import {
  REDEMPTION_TICKET_CONFIG
} from './ticketConfig.js';

import {
  requireRedemptionStaffAccess
} from './redemptionStaffAuth.js';

import {
  buildNativeCloseConfirmation
} from './nativeCloseComponents.js';

import {
  getPaymentPool
} from '../../commands/Economy/modules/paymentHandler.js';

export const REDEMPTION_CLOSE_BUTTON_ID =
  'cunvrs_redemption_close';

export async function verifyNativeTicketCanClose(
  interaction,
  options = {}
) {
  assertNativeStaffButtonsEnabled("archive");

  if (process.env.CUNVRS_REDEMPTIONS_ENABLED !== 'true') {
    throw new Error('Redemptions are disabled.');
  }

  requireRedemptionStaffAccess(interaction, 'close');

  if (
    !interaction.guildId ||
    !interaction.channelId ||
    interaction.channel?.id !== interaction.channelId ||
    interaction.channel?.type !== ChannelType.GuildText ||
    interaction.channel?.parentId !== REDEMPTION_TICKET_CONFIG.categoryId
  ) {
    throw new Error('Not a native redemption ticket.');
  }

  const pool = options.pool ?? getPaymentPool();

  const ownership = await pool.query(
    `SELECT owner_id
     FROM cunvrs_ticketcord_owners
     WHERE guild_id=$1
       AND channel_id=$2
       AND verification_method='cunvrs_native_created'`,
    [interaction.guildId, interaction.channelId]
  );

  if (ownership.rows.length !== 1) {
    throw new Error('Native ticket ownership not verified.');
  }

  const ownerId = ownership.rows[0].owner_id;

  const unresolved = await pool.query(
    `SELECT COUNT(*)::integer AS pending_count
     FROM cunvrs_redemptions
     WHERE guild_id=$1
       AND channel_id=$2
       AND user_id=$3
       AND status NOT IN ('declined', 'delivered')`,
    [interaction.guildId, interaction.channelId, ownerId]
  );

  const count = Number(
    unresolved.rows[0]?.pending_count
  );

  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Could not verify redemption statuses.');
  }

  if (count > 0) {
    throw new Error(
      `This ticket has ${count} unresolved redemption(s).`
    );
  }

  return { ownerId, unresolvedCount: 0 };
}

export async function handleNativeCloseRequest(
  interaction,
  options = {}
) {
  if (interaction.customId !== REDEMPTION_CLOSE_BUTTON_ID) {
    return false;
  }

  await interaction.deferReply();

  try {
    assertNativeStaffButtonsEnabled("close");
    await verifyNativeTicketCanClose(interaction, options);

    await interaction.editReply(
      buildNativeCloseConfirmation()
    );
  } catch (error) {
    console.error('[native redemption close]', error.message);

    await interaction.editReply({
      content:
        '♡ this ticket cannot be closed yet.\n' +
        '-# Please check that all redemptions are resolved ' +
        'and that you have manager permissions.',
      components: [],
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }

  return true;
}
