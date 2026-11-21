import {
  ChannelType
} from 'discord.js';

import {
  getPaymentPool
} from '../../commands/Economy/modules/paymentHandler.js';

import {
  REDEMPTION_TICKET_CONFIG as config
} from './ticketConfig.js';

import {
  requireRedemptionStaffAccess
} from './redemptionStaffAuth.js';

export async function markNativeTicketArchived(
  interaction,
  archiveMessageId,
  options = {}
) {
  if (process.env.CUNVRS_REDEMPTIONS_ENABLED !== 'true') {
    throw new Error('Redemptions are disabled.');
  }

  requireRedemptionStaffAccess(interaction, 'close');

  if (
    !interaction.guildId ||
    !interaction.channelId ||
    interaction.channel?.id !== interaction.channelId ||
    interaction.channel?.type !== ChannelType.GuildText ||
    interaction.channel?.parentId !== config.categoryId ||
    !interaction.user?.id ||
    typeof archiveMessageId !== 'string' ||
    !/^\d{15,22}$/.test(archiveMessageId)
  ) {
    throw new Error('Invalid native ticket archive request.');
  }

  const pool = options.pool ?? getPaymentPool();
  const db = await pool.connect();
  let active = false;

  try {
    await db.query('BEGIN');
    active = true;

    await db.query(
      `SELECT pg_advisory_xact_lock(
         hashtext($1), hashtext($2)
       )`,
      [interaction.guildId, interaction.channelId]
    );

    const updated = await db.query(
      `UPDATE cunvrs_native_redemption_closures
       SET state='archived',
           archive_message_id=$4,
           updated_at=NOW()
       WHERE guild_id=$1
         AND channel_id=$2
         AND started_by=$3
         AND state='closing'
         AND archive_message_id IS NULL
       RETURNING channel_id, archive_message_id`,
      [
        interaction.guildId,
        interaction.channelId,
        interaction.user.id,
        archiveMessageId
      ]
    );

    await db.query('COMMIT');
    active = false;

    return {
      success: updated.rows.length === 1,
      archiveMessageId: updated.rows[0]?.archive_message_id
    };
  } catch (error) {
    if (active) {
      await db.query('ROLLBACK').catch(() => {});
    }

    throw error;
  } finally {
    db.release();
  }
}
