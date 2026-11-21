import { verifyNativeArchiveMessage } from './nativeArchiveVerification.js';
﻿import { ChannelType } from 'discord.js';

import { getPaymentPool } from '../../commands/Economy/modules/paymentHandler.js';
import { REDEMPTION_TICKET_CONFIG as config } from './ticketConfig.js';
import { requireRedemptionStaffAccess } from './redemptionStaffAuth.js';

const ID = /^\d{15,22}$/;
const MARKER = 'CUNVRS_NATIVE_ARCHIVE_ONLY_V1';

export async function reconcileDeletedNativeTicket(
  interaction,
  options = {}
) {
  // Independent switch. Recovery cannot run accidentally.
  if (
    process.env.CUNVRS_REDEMPTION_RECOVERY_ENABLED !== 'true'
  ) {
    throw new Error('Redemption recovery is disabled.');
  }

  requireRedemptionStaffAccess(interaction, 'close');

  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  const botId = interaction.client?.user?.id;

  if (
    !ID.test(guildId ?? '') ||
    !ID.test(channelId ?? '') ||
    !ID.test(botId ?? '') ||
    interaction.guild?.id !== guildId
  ) {
    throw new Error('Invalid recovery context.');
  }

  const pool = options.pool ?? getPaymentPool();

  // The channel must truly be absent.
  // Discord API failures propagate instead of being treated as deletion.
  const channel = await interaction.guild.channels.fetch(channelId);

  if (channel !== null) {
    return {
      success: false,
      reason: 'Ticket channel still exists.'
    };
  }

  const logChannel = options.logChannel ??
    await interaction.client.channels.fetch(config.logChannelId);

  if (
    logChannel?.id !== config.logChannelId ||
    logChannel.guild?.id !== guildId ||
    logChannel.type !== ChannelType.GuildText
  ) {
    throw new Error('Private archive log is unavailable.');
  }

  const db = await pool.connect();
  let active = false;

  try {
    await db.query('BEGIN');
    active = true;

    await db.query(
      `SELECT pg_advisory_xact_lock(
         hashtext($1), hashtext($2)
       )`,
      [guildId, channelId]
    );

    const result = await db.query(
      `SELECT state, owner_id, archive_message_id
       FROM cunvrs_native_redemption_closures
       WHERE guild_id=$1 AND channel_id=$2
       FOR UPDATE`,
      [guildId, channelId]
    );

    const record = result.rows[0];

    if (
      record?.state !== 'deleting' ||
      !ID.test(record.archive_message_id ?? '')
    ) {
      await db.query('COMMIT');
      active = false;

      return {
        success: false,
        reason: 'No eligible interrupted deletion found.'
      };
    }

    // Verify native ticket ownership is still recorded.
    const ownership = await db.query(
      `SELECT owner_id
       FROM cunvrs_ticketcord_owners
       WHERE guild_id=$1 AND channel_id=$2
         AND verification_method='cunvrs_native_created'`,
      [guildId, channelId]
    );

    if (
      ownership.rows.length !== 1 ||
      ownership.rows[0].owner_id !== record.owner_id
    ) {
      throw new Error('Native ticket ownership mismatch.');
    }

    // Confirm no active financial requests remain.
    const unresolved = await db.query(
      `SELECT COUNT(*)::integer AS count
       FROM cunvrs_redemptions
       WHERE guild_id=$1 AND channel_id=$2
         AND status NOT IN ('declined', 'delivered')`,
      [guildId, channelId]
    );

    if (Number(unresolved.rows[0]?.count) !== 0) {
      throw new Error('Unresolved redemptions block recovery.');
    }

    // Read the saved archive from the actual log channel.
    const archive = await logChannel.messages.fetch(
      record.archive_message_id
    );

    const verified = verifyNativeArchiveMessage({
      message: archive,
      botId,
      channelId,
      archiveMessageId: record.archive_message_id
    });

    if (!verified) {
      throw new Error(
        'Archive identity could not be verified.'
      );
    }

    const updated = await db.query(
      `UPDATE cunvrs_native_redemption_closures
       SET state='closed', updated_at=NOW()
       WHERE guild_id=$1 AND channel_id=$2
         AND state='deleting'
         AND archive_message_id=$3
       RETURNING channel_id`,
      [guildId, channelId, record.archive_message_id]
    );

    if (updated.rows.length !== 1) {
      throw new Error('Recovery state update failed.');
    }

    await db.query('COMMIT');
    active = false;

    return {
      success: true,
      state: 'closed',
      archiveMessageId: record.archive_message_id,
      deletedAgain: false
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
