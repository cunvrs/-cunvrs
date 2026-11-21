import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';

export const REDEMPTION_CLOSE_CONFIRM_ID =
  'cunvrs_redemption_close_confirm';

export const REDEMPTION_CLOSE_CANCEL_ID =
  'cunvrs_redemption_close_cancel';

export function buildNativeCloseConfirmation() {
  return {
    content:
      '## 🎀 ⋮ __close redemption ticket?__\n\n' +
      '♡ a transcript must be saved to the private log.\n' +
      '♡ unresolved redemptions will block closing.\n' +
      '♡ only authorized managers can confirm.\n\n' +
      '**Are you sure you want to close this ticket?**',
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(REDEMPTION_CLOSE_CONFIRM_ID)
          .setLabel('Confirm Close')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(REDEMPTION_CLOSE_CANCEL_ID)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      )
    ],
    allowedMentions: { parse: [] }
  };
}
