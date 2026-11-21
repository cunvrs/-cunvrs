import { deleteArchivedNativeTicket } from './nativeTicketDeletion.js';
﻿import {
  beginNativeTicketClosing
} from './nativeClosingState.js';

import {
  archiveNativeRedemptionTicket
} from './nativeCloseConfirmInteraction.js';

import {
  markNativeTicketArchived
} from './nativeArchiveState.js';

export async function prepareNativeTicketForDeletion(
  interaction,
  options = {}
) {
  // This is archive-only. No channel deletion occurs here.
  const started = await beginNativeTicketClosing(
    interaction,
    options
  );

  if (!started.success) {
    return {
      success: false,
      archived: false,
      deleted: false,
      reason: started.reason
    };
  }

  try {
    const archived = await archiveNativeRedemptionTicket(
      interaction,
      options
    );

    if (
      typeof archived.archiveMessageId !== 'string' ||
      !/^\d{15,22}$/.test(archived.archiveMessageId)
    ) {
      throw new Error(
        'Discord did not return a valid archive message ID.'
      );
    }

    const saved = await markNativeTicketArchived(
      interaction,
      archived.archiveMessageId,
      options
    );

    if (!saved.success) {
      throw new Error(
        'Archive was uploaded but could not be recorded.'
      );
    }


        // CUNVRS_CLOSE_DELETION_INTEGRATION_V1
        // Final deletion requires its own feature flag.
        if (
          process.env.CUNVRS_REDEMPTION_DELETION_ENABLED === 'true'
        ) {
          const deletion = await deleteArchivedNativeTicket(
            interaction,
            options
          );

          if (!deletion.success) {
            return {
              success: false,
              archived: true,
              deleted: false,
              recoveryRequired: true,
              archiveMessageId: saved.archiveMessageId,
              reason: deletion.reason ??
                'Archive saved, but deletion did not complete.'
            };
          }

          return {
            success: true,
            archived: true,
            deleted: true,
            ownerId: started.ownerId,
            archiveMessageId: saved.archiveMessageId,
            messageCount: archived.messageCount
          };
        }

        return {
      success: true,
      archived: true,
      deleted: false,
      ownerId: started.ownerId,
      archiveMessageId: saved.archiveMessageId,
      messageCount: archived.messageCount
    };
  } catch (error) {
    // Never delete the ticket or automatically release the lock.
    // A Discord upload could have succeeded before an error.
    console.error(
      '[native redemption archive recovery required]',
      {
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        error: error.message
      }
    );

    return {
      success: false,
      archived: false,
      deleted: false,
      recoveryRequired: true,
      reason: error.message
    };
  }
}
