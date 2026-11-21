import { assertNativeStaffButtonsEnabled } from './nativeStaffButtonFlags.js';
﻿import {
  REDEMPTION_CLOSE_CONFIRM_ID,
  REDEMPTION_CLOSE_CANCEL_ID
} from './nativeCloseComponents.js';

import {
  prepareNativeTicketForDeletion
} from './nativeCloseLifecycle.js';

export async function handleNativeCloseFinalConfirmation(
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
    assertNativeStaffButtonsEnabled("close");

    const result = await prepareNativeTicketForDeletion(
      interaction,
      options
    );

    if (!result.success) {
      await interaction.editReply({
        content: result.recoveryRequired
          ? '♡ closing needs staff recovery.\n' +
            '-# Deletion status is unconfirmed. ' +
            'Please check the private archive log.'
          : '♡ this ticket cannot be closed yet.\n' +
            `-# ${result.reason ?? 'Closing is unavailable.'}`,
        components: [],
        allowedMentions: { parse: [] }
      });

      return true;
    }

    // CUNVRS_CLOSE_DELETED_REPLY_V1
    if (result.deleted === true) {
      // Discord may invalidate replies after deleting the channel.
      await interaction.editReply({
        content:
          '## \u{1F380} \u22EE __ticket closed!__\n\n' +
          '\u2661 transcript saved to the private log.\n' +
          '\u2661 redemption ticket deleted successfully.',
        components: [],
        allowedMentions: { parse: [] }
      }).catch(error => {
        console.warn(
          '[native close] deleted channel reply unavailable:',
          error.message
        );
      });

      return true;
    }

    await interaction.editReply({
      content:
        '## 🎀 ⋮ __ticket archived!__\n\n' +
        '♡ the transcript was saved to the private log.\n' +
        `♡ **messages saved:** ${result.messageCount}\n\n` +
        '-# Ticket deletion is not enabled yet. ' +
        'The channel remains open.',
      components: [],
      allowedMentions: { parse: [] }
    });

  } catch (error) {
    console.error(
      '[native close lifecycle]',
      error.message
    );

    await interaction.editReply({
      content:
        '♡ ticket closing could not be completed.\n' +
        '-# Channel status is unconfirmed. Staff should review ' +
        'its closing state before trying again.',
      components: [],
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }

  return true;
}
