import { ChannelType } from 'discord.js';
import { getPaymentPool } from '../../commands/Economy/modules/paymentHandler.js';
import { REDEMPTION_TICKET_CONFIG } from './ticketConfig.js';
import { requireRedemptionStaffAccess } from './redemptionStaffAuth.js';

export async function claimNativeRedemptionTicket(interaction, options = {}) {
  if (process.env.CUNVRS_REDEMPTIONS_ENABLED !== 'true') {
    throw new Error('Redemption tickets are not enabled yet.');
  }

  requireRedemptionStaffAccess(interaction, 'claim');

  const config = REDEMPTION_TICKET_CONFIG;
  const channel = interaction.channel;

  if (
    !interaction.guildId ||
    !interaction.user?.id ||
    !channel ||
    channel.type !== ChannelType.GuildText ||
    channel.parentId !== config.categoryId ||
    interaction.channelId !== channel.id
  ) {
    throw new Error('This is not a valid redemption ticket channel.');
  }

  const pool = options.pool ?? getPaymentPool();

  const claimed = await pool.query(
    `INSERT INTO cunvrs_native_redemption_claims
       (channel_id, claimed_by)
     SELECT channel_id, $3
     FROM cunvrs_ticketcord_owners
     WHERE guild_id = $1
       AND channel_id = $2
       AND verification_method = 'cunvrs_native_created'
     ON CONFLICT (channel_id) DO NOTHING
     RETURNING claimed_by`,
    [interaction.guildId, channel.id, interaction.user.id]
  );

  if (claimed.rows.length === 1) {
    return {
      claimed: true,
      claimedBy: interaction.user.id
    };
  }

  const existing = await pool.query(
    `SELECT c.claimed_by
     FROM cunvrs_native_redemption_claims c
     JOIN cunvrs_ticketcord_owners o
       ON o.channel_id = c.channel_id
     WHERE o.guild_id = $1
       AND o.channel_id = $2
       AND o.verification_method = 'cunvrs_native_created'`,
    [interaction.guildId, channel.id]
  );

  if (!existing.rows.length) {
    throw new Error('Native redemption ticket is not registered.');
  }

  return {
    claimed: false,
    claimedBy: existing.rows[0].claimed_by
  };
}
