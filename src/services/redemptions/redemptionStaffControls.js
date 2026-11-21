import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from 'discord.js';

export const REDEMPTION_STAFF_BUTTONS = Object.freeze({
  claim: 'cunvrs_redemption_claim',
  approve: 'cunvrs_redemption_approve',
  decline: 'cunvrs_redemption_decline',
  deliver: 'cunvrs_redemption_deliver',
  close: 'cunvrs_redemption_close'
});

export function buildRedemptionStaffControls() {
  const embed = new EmbedBuilder()
    .setColor(0xFFB6D5)
    .setDescription(
      '## 🎀 ⋮ __redemption controls!__\n\n' +
      '**staff management panel**\n\n' +
      '♡ claim a ticket to assist the member.\n' +
      '♡ approve or decline redemption requests.\n' +
      '♡ confirm reward delivery with evidence.\n' +
      '♡ close the ticket after completion.\n\n' +
      '-# staff authorization is required for all actions.'
    )
    .setFooter({
      text: 'cunvrs. • redemption management'
    });

  const buttons = [
    ['claim', 'Claim', ButtonStyle.Secondary],
    ['approve', 'Approve', ButtonStyle.Success],
    ['decline', 'Decline', ButtonStyle.Danger],
    ['deliver', 'Deliver', ButtonStyle.Primary],
    ['close', 'Close', ButtonStyle.Secondary]
  ].map(([action, label, style]) =>
    new ButtonBuilder()
      .setCustomId(REDEMPTION_STAFF_BUTTONS[action])
      .setLabel(label)
      .setStyle(style)
      // CUNVRS_STAFF_BUTTON_FLAGS_V1
      .setDisabled(
        action !== 'claim' &&
        !(
          process.env.CUNVRS_REDEMPTIONS_ENABLED === 'true' &&
          process.env.CUNVRS_REDEMPTION_STAFF_BUTTONS_ENABLED === 'true' &&
          (
            action !== 'close' ||
            process.env.CUNVRS_REDEMPTION_DELETION_ENABLED === 'true'
          )
        )
      )
  );

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(...buttons)
    ]
  };
}
