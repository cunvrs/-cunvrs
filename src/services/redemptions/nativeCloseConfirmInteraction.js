import {
  ChannelType
} from 'discord.js';

import {
  REDEMPTION_TICKET_CONFIG as config
} from './ticketConfig.js';

import {
  REDEMPTION_CLOSE_CONFIRM_ID,
  REDEMPTION_CLOSE_CANCEL_ID
} from './nativeCloseComponents.js';

import {
  verifyNativeTicketCanClose
} from './nativeCloseInteraction.js';

import {
  buildNativeRedemptionTranscript
} from './nativeTranscript.js';

const ARCHIVE_MARKER = 'CUNVRS_NATIVE_ARCHIVE_ONLY_V1';

export async function archiveNativeRedemptionTicket(
  interaction,
  options = {}
) {
  const firstCheck = await verifyNativeTicketCanClose(
    interaction,
    options
  );

  const logChannel = options.logChannel ??
    await interaction.client.channels.fetch(config.logChannelId);

  if (
    !logChannel ||
    logChannel.id !== config.logChannelId ||
    logChannel.guild?.id !== interaction.guildId ||
    logChannel.type !== ChannelType.GuildText ||
    typeof logChannel.send !== 'function'
  ) {
    throw new Error('Private redemption log channel unavailable.');
  }

  const transcript = await buildNativeRedemptionTranscript(
    interaction.channel
  );

  // Recheck after potentially slow message pagination.
  const finalCheck = await verifyNativeTicketCanClose(
    interaction,
    options
  );

  if (firstCheck.ownerId !== finalCheck.ownerId) {
    throw new Error('Ticket ownership changed during archival.');
  }

  const archiveMessage = await logChannel.send({
    content: [
      '## 🎀 ⋮ __redemption transcript archived!__',
      '',
      `**ticket:** ${interaction.channelId}`,
      `**owner:** <@${firstCheck.ownerId}>`,
      `**staff:** <@${interaction.user.id}>`,
      `**messages:** ${transcript.messageCount}`,
      '',
      '-# Archive only — ticket has not been deleted.',
      `-# ${ARCHIVE_MARKER}`
    ].join('\n'),
    files: [transcript.attachment],
    allowedMentions: { parse: [] }
  });

  return {
    archived: true,
    archiveMessageId: archiveMessage?.id,
    deleted: false,
    ownerId: firstCheck.ownerId,
    messageCount: transcript.messageCount
  };
}

export async function handleNativeCloseConfirmation(
  interaction,
  options = {}
) {
  if (
    interaction.customId !== REDEMPTION_CLOSE_CONFIRM_ID &&
    interaction.customId !== REDEMPTION_CLOSE_CANCEL_ID
  ) {
    return false;
  }

  if (interaction.customId === REDEMPTION_CLOSE_CANCEL_ID) {
    await interaction.update({
      content: '♡ ticket closing cancelled.',
      components: [],
      allowedMentions: { parse: [] }
    });

    return true;
  }

  await interaction.deferUpdate();

  try {
    const result = await archiveNativeRedemptionTicket(
      interaction,
      options
    );

    await interaction.editReply({
      content:
        '♡ transcript saved to the private redemption log!\n' +
        `-# ${result.messageCount} messages archived.\n` +
        '-# Ticket remains open until final closing safety checks are installed.',
      components: [],
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    console.error(
      '[native redemption transcript archive]',
      error.message
    );

    await interaction.editReply({
      content:
        '♡ this ticket could not be archived safely.\n' +
        '-# The ticket remains open. Staff should check the logs.',
      components: [],
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }

  return true;
}
