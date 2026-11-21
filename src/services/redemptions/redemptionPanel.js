import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from 'discord.js';

import { UNICOIN_EMOJI } from '../../utils/wallet.js';

export const REDEMPTION_PANEL_CHANNEL_ID = '1573503937376420011';
export const REDEMPTION_CATEGORY_ID = '1573499227886059550';
export const REDEMPTION_LOG_CHANNEL_ID = '1573395941510225950';

export const REDEMPTION_OPEN_BUTTON_ID = 'cunvrs_redeem_open';

export function buildRedemptionPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xFFB6D5)
    .setDescription(
      '## 🎀 ⋮ __unicoin redemptions!__\n\n' +
      '**redeem your Unicoins for exclusive rewards!**\n\n' +
      `**${UNICOIN_EMOJI} ⋮ available rewards!**\n\n` +
      '🎀 **UGC reward** — 12,000 Unicoins\n' +
      '👑 **30-day VIP** — 20,000 Unicoins\n' +
      '💎 **Robux** — coming soon\n\n' +
      '୭ open a private ticket below to request a reward!\n' +
      '-# rewards require staff approval.'
    )
    .setFooter({
      text: 'cunvrs. • unicoin redemption center'
    });

  const button = new ButtonBuilder()
    .setCustomId(REDEMPTION_OPEN_BUTTON_ID)
    .setLabel('open redemption ticket')
    .setEmoji('🎟️')
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder().addComponents(button);

  return {
    embeds: [embed],
    components: [row]
  };
}
