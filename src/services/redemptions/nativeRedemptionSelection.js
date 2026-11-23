import { assertNativeStaffButtonsEnabled } from './nativeStaffButtonFlags.js';
﻿import { ChannelType } from 'discord.js';

import { getPaymentPool } from '../../commands/Economy/modules/paymentHandler.js';
import { REDEMPTION_TICKET_CONFIG } from './ticketConfig.js';
import { requireRedemptionStaffAccess } from './redemptionStaffAuth.js';

const ALLOWED_STATUSES = Object.freeze({
  approve: ['pending_approval'],
  decline: ['pending_approval', 'approved'],
  deliver: ['approved', 'in_progress']
});

export async function listNativeTicketRedemptions(
  interaction,
  action,
  options = {}
) {
  assertNativeStaffButtonsEnabled(action);

  if (process.env.CUNVRS_REDEMPTIONS_ENABLED !== 'true') {
    throw new Error('Redemptions are disabled.');
  }

  const statuses = ALLOWED_STATUSES[action];

  if (!statuses) {
    throw new Error('Invalid redemption action.');
  }

  requireRedemptionStaffAccess(interaction, action);

  if (
    !interaction.guildId ||
    !interaction.channelId ||
    !interaction.channel ||
    interaction.channel.id !== interaction.channelId ||
    interaction.channel.type !== ChannelType.GuildText ||
    interaction.channel.parentId !== REDEMPTION_TICKET_CONFIG.categoryId
  ) {
    throw new Error('This is not a native redemption ticket.');
  }

  const pool = options.pool ?? getPaymentPool();

  const result = await pool.query(
    `SELECT
       r.id,
       r.item_code,
       r.details->>'itemName' AS item_name,
       r.status,
       r.coins_reserved,
       r.requested_at
     FROM cunvrs_redemptions AS r
     INNER JOIN cunvrs_ticketcord_owners AS o
       ON o.guild_id = r.guild_id
      AND o.channel_id = r.channel_id
      AND o.owner_id = r.user_id
      AND o.verification_method = 'cunvrs_native_created'
     WHERE r.guild_id = $1
       AND r.channel_id = $2
       AND r.status = ANY($3::text[])
     ORDER BY r.requested_at DESC, r.id DESC
     LIMIT 25`,
    [
      interaction.guildId,
      interaction.channelId,
      statuses
    ]
  );

  return result.rows;
}
