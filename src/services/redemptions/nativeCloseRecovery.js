import { ChannelType } from 'discord.js';
import { getPaymentPool } from '../../commands/Economy/modules/paymentHandler.js';
import { REDEMPTION_TICKET_CONFIG as config } from './ticketConfig.js';
import { requireRedemptionStaffAccess } from './redemptionStaffAuth.js';

const ID = /^\d{15,22}$/;

export async function inspectNativeTicketRecovery(
  interaction,
  options = {}
) {
  requireRedemptionStaffAccess(interaction, 'close');

  if (
    !ID.test(interaction.guildId ?? '') ||
    !ID.test(interaction.channelId ?? '')
  ) {
    throw new Error('Invalid ticket identifiers.');
  }

  const pool = options.pool ?? getPaymentPool();

  const found = await pool.query(
    `SELECT state, owner_id, started_by,
            archive_message_id, updated_at
     FROM cunvrs_native_redemption_closures
     WHERE guild_id=$1 AND channel_id=$2`,
    [interaction.guildId, interaction.channelId]
  );

  if (found.rows.length !== 1) {
    return {
      status: 'not_found',
      safeToDelete: false,
      recommendation: 'No closing record. Manual review required.'
    };
  }

  const record = found.rows[0];

  if (!['closing', 'archived', 'deleting', 'closed']
    .includes(record.state)) {
    throw new Error('Unknown ticket closing state.');
  }

  const guild = interaction.guild;

  if (!guild || guild.id !== interaction.guildId) {
    throw new Error('Discord guild verification failed.');
  }

  const channel = await guild.channels.fetch(
    interaction.channelId
  );

  const channelExists = Boolean(channel);

  if (
    channel &&
    (
      channel.id !== interaction.channelId ||
      channel.type !== ChannelType.GuildText ||
      channel.parentId !== config.categoryId
    )
  ) {
    throw new Error('Ticket channel identity changed.');
  }

  let archiveVerified = false;

  if (ID.test(record.archive_message_id ?? '')) {
    const log = options.logChannel ??
      await interaction.client.channels.fetch(config.logChannelId);

    if (
      log?.id === config.logChannelId &&
      log.guild?.id === interaction.guildId &&
      log.type === ChannelType.GuildText
    ) {
      const archive = await log.messages.fetch(
        record.archive_message_id
      );

      archiveVerified = Boolean(
        archive &&
        archive.content?.includes(
          'CUNVRS_NATIVE_ARCHIVE_ONLY_V1'
        ) &&
        [...(archive.attachments?.values() ?? [])].some(
          attachment =>
            attachment.name ===
              `cunvrs-redemption-${interaction.channelId}.txt`
        )
      );
    }
  }

  let recommendation;

  if (record.state === 'closing') {
    recommendation =
      'Inspect the private log for a possible upload. ' +
      'Do not retry or delete automatically.';
  } else if (!archiveVerified) {
    recommendation =
      'Transcript archive is unverified. ' +
      'Do not delete or mark closed.';
  } else if (record.state === 'deleting' && !channelExists) {
    recommendation =
      'Discord channel is absent, but database says deleting. ' +
      'Manual closed-state reconciliation required.';
  } else if (record.state === 'deleting') {
    recommendation =
      'Deletion was interrupted while the channel still exists. ' +
      'Manual recovery required.';
  } else if (record.state === 'archived' && channelExists) {
    recommendation =
      'Archive is present. Review deletion eligibility separately.';
  } else if (record.state === 'closed' && !channelExists) {
    recommendation =
      'Closed state and channel absence are consistent.';
  } else {
    recommendation =
      'Channel and database state disagree. Manual review required.';
  }

  return {
    status: record.state,
    ownerId: record.owner_id,
    startedBy: record.started_by,
    archiveMessageId: record.archive_message_id,
    channelExists,
    archiveVerified,
    safeToDelete: false,
    recommendation
  };
}
