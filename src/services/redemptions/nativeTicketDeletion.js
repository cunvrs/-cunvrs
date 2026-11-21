import { verifyNativeArchiveMessage } from './nativeArchiveVerification.js';
﻿import { ChannelType } from 'discord.js';

import {
  getPaymentPool
} from '../../commands/Economy/modules/paymentHandler.js';

import {
  REDEMPTION_TICKET_CONFIG as config
} from './ticketConfig.js';

import {
  requireRedemptionStaffAccess
} from './redemptionStaffAuth.js';

const ID_PATTERN = /^\d{15,22}$/;

function validate(interaction) {
  if (process.env.CUNVRS_REDEMPTIONS_ENABLED !== 'true') {
    throw new Error('Redemptions are disabled.');
  }

  if (
    process.env.CUNVRS_REDEMPTION_DELETION_ENABLED !== 'true'
  ) {
    throw new Error('Ticket deletion is disabled.');
  }

  requireRedemptionStaffAccess(interaction, 'close');

  if (
    !ID_PATTERN.test(interaction.guildId ?? '') ||
    !ID_PATTERN.test(interaction.channelId ?? '') ||
    !interaction.user?.id ||
    interaction.channel?.id !== interaction.channelId ||
    interaction.channel?.type !== ChannelType.GuildText ||
    interaction.channel?.parentId !== config.categoryId
  ) {
    throw new Error('Invalid native redemption ticket.');
  }
}

async function transaction(pool, work) {
  const db = await pool.connect();
  let active = false;

  try {
    await db.query('BEGIN');
    active = true;

    const result = await work(db);

    await db.query('COMMIT');
    active = false;

    return result;
  } catch (error) {
    if (active) {
      await db.query('ROLLBACK').catch(() => {});
    }

    throw error;
  } finally {
    db.release();
  }
}

export async function deleteArchivedNativeTicket(
  interaction,
  options = {}
) {
  validate(interaction);

  const pool = options.pool ?? getPaymentPool();
  const ids = [interaction.guildId, interaction.channelId];

  // Reserve exclusive deletion ownership before Discord API actions.
  const reserved = await transaction(pool, async db => {
    await db.query(
      `SELECT pg_advisory_xact_lock(
         hashtext($1), hashtext($2)
       )`,
      ids
    );

    const result = await db.query(
      `SELECT state, owner_id, archive_message_id
       FROM cunvrs_native_redemption_closures
       WHERE guild_id=$1 AND channel_id=$2
       FOR UPDATE`,
      ids
    );

    const record = result.rows[0];

    if (
      record?.state !== 'archived' ||
      !ID_PATTERN.test(record.archive_message_id ?? '')
    ) {
      return {
        success: false,
        reason: 'Ticket is not ready for deletion.'
      };
    }

    const unresolved = await db.query(
      `SELECT COUNT(*)::integer AS count
       FROM cunvrs_redemptions
       WHERE guild_id=$1 AND channel_id=$2
         AND status NOT IN ('declined', 'delivered')`,
      ids
    );

    if (Number(unresolved.rows[0]?.count) !== 0) {
      return {
        success: false,
        reason: 'Ticket contains unresolved redemptions.'
      };
    }

    const updated = await db.query(
      `UPDATE cunvrs_native_redemption_closures
       SET state='deleting', updated_at=NOW()
       WHERE guild_id=$1 AND channel_id=$2
         AND state='archived'
       RETURNING archive_message_id`,
      ids
    );

    if (updated.rows.length !== 1) {
      throw new Error('Failed to reserve ticket deletion.');
    }

    return {
      success: true,
      archiveMessageId: record.archive_message_id
    };
  });

  if (!reserved.success) {
    return { ...reserved, deleted: false };
  }

  // An interrupted attempt remains in 'deleting' for recovery.
  const logChannel = options.logChannel ??
    await interaction.client.channels.fetch(config.logChannelId);

  if (
    logChannel?.id !== config.logChannelId ||
    logChannel.guild?.id !== interaction.guildId ||
    logChannel.type !== ChannelType.GuildText
  ) {
    throw new Error(
      'Private log unavailable. Ticket remains for recovery.'
    );
  }

  const archive = await logChannel.messages.fetch(
    reserved.archiveMessageId
  );

  if (!verifyNativeArchiveMessage({
    message: archive,
    botId: interaction.client?.user?.id,
    channelId: interaction.channelId,
    archiveMessageId: reserved.archiveMessageId
  })) {
    throw new Error(
      'Verified transcript archive missing. Do not delete.'
    );
  }

  // The archive is verified and this ticket has exclusive
  // deletion state. Actual Discord deletion occurs here.
  await interaction.channel.delete(
    `cunvrs archived redemption closed by ${interaction.user.id}`
  );

  // Record the closure after confirmed Discord deletion.
  // On database failure, 'deleting' remains for recovery.
  await transaction(pool, async db => {
    await db.query(
      `SELECT pg_advisory_xact_lock(
         hashtext($1), hashtext($2)
       )`,
      ids
    );

    const updated = await db.query(
      `UPDATE cunvrs_native_redemption_closures
       SET state='closed', updated_at=NOW()
       WHERE guild_id=$1 AND channel_id=$2
         AND state='deleting'
         AND archive_message_id=$3
       RETURNING channel_id`,
      [...ids, reserved.archiveMessageId]
    );

    if (updated.rows.length !== 1) {
      throw new Error('Closed-state update requires recovery.');
    }
  });

  return {
    success: true,
    deleted: true,
    archiveMessageId: reserved.archiveMessageId
  };
}
