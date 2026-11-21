
import {
  SlashCommandBuilder,
  EmbedBuilder,
} from 'discord.js';

import { getPaymentPool } from './modules/paymentHandler.js';
import { playGuessNumber } from './modules/minigameRewards.js';
import { UNICOIN_EMOJI } from '../../utils/wallet.js';

const PINK = 0xFFEDF4;

function embed(description) {
  return new EmbedBuilder()
    .setColor(PINK)
    .setDescription(description)
    .setFooter({ text: 'cunvrs. minigames' });
}

export default {
  data: new SlashCommandBuilder()
    .setName('guessnumber')
    .setDescription('Guess the number from 1 to 10!')
    .addIntegerOption(option =>
      option
        .setName('number')
        .setDescription('Your guess (1–10)')
        .setMinValue(1)
        .setMaxValue(10)
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    if (!interaction.guildId) {
      await interaction.editReply({
        content: '♡ play minigames inside a server!',
      });
      return;
    }

    try {
      const result = await playGuessNumber(
        getPaymentPool(),
        {
          guildId: interaction.guildId,
          userId: interaction.user.id,
          interactionId: interaction.id,
          guess: interaction.options.getInteger('number'),
        }
      );

      if (result.cooldown) {
        await interaction.editReply({
          embeds: [
            embed(
              `## 🎲 ⋮ **__guess the number!__**\n\n` +
              '♡ you already played recently!\n\n' +
              `**play again:** <t:${Math.ceil(result.nextPlay / 1000)}:R>`
            ),
          ],
        });
        return;
      }

      const message = result.won
        ? `🎀 **you guessed correctly!**\n\n` +
          `${UNICOIN_EMOJI} **earned:** +${result.earned}\n` +
          `✨ **XP:** +${result.xpEarned}`
        : '♡ not quite! better luck next time!';

      await interaction.editReply({
        embeds: [
          embed(
            `## 🎲 ⋮ **__guess the number!__**\n\n` +
            `♡ your guess: **${result.guess}**\n` +
            `♡ winning number: **${result.winningNumber}**\n\n` +
            message +
            `\n\n♡ **wallet:** ${result.wallet.toLocaleString()}\n` +
            `♡ **minigame earnings today:** ${result.dailyMinigameCoins}/1,500\n` +
            `♡ **next game:** <t:${Math.ceil(result.nextPlay / 1000)}:R>`
          ),
        ],
      });
    } catch (error) {
      console.error('[CUNVRS GUESSNUMBER]', error);

      await interaction.editReply({
        embeds: [
          embed(
            `## 🎲 ⋮ **__game unavailable!__**\n\n` +
            '♡ your game could not be confirmed. ' +
            'please try again later.'
          ),
        ],
      }).catch(() => {});
    }
  },
};
