import {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { randomInt, randomUUID } from 'node:crypto';
import { getPaymentPool } from './modules/paymentHandler.js';
import { getGameCooldown, settleMinigame } from './modules/gameRewardService.js';
import { UNICOIN_EMOJI } from '../../utils/wallet.js';

// Discord select menus permit at most 25 choices. This is a compact word-list Wordle variant.
const WORDS = Object.freeze([
  'APPLE', 'BEACH', 'BERRY', 'BLOOM', 'BLUSH', 'CANDY', 'CHARM', 'CLOUD',
  'CORAL', 'CREAM', 'DREAM', 'FAIRY', 'FLORA', 'GLOVE', 'GRAPE', 'HEART',
  'HONEY', 'LEMON', 'LIGHT', 'MAGIC', 'PEACH', 'PEARL', 'PLUSH', 'ROSES', 'SWEET',
]);
const embed = message => new EmbedBuilder().setColor(0xFFEDF4)
  .setDescription(`## 🌸 ⋮ **__wordle!__**\n\n${message}`)
  .setFooter({ text: 'cunvrs. minigames' });

export function score(word, guess) {
  const marks = Array(5).fill('⬛');
  const remaining = new Map();
  for (let i = 0; i < 5; i++) {
    if (guess[i] === word[i]) marks[i] = '🟩';
    else remaining.set(word[i], (remaining.get(word[i]) || 0) + 1);
  }
  for (let i = 0; i < 5; i++) {
    if (marks[i] === '🟩') continue;
    if ((remaining.get(guess[i]) || 0) > 0) {
      marks[i] = '🟨';
      remaining.set(guess[i], remaining.get(guess[i]) - 1);
    }
  }
  return marks.join('');
}

export default {
  data: new SlashCommandBuilder().setName('wordle')
    .setDescription('Find the five-letter word in six guesses!'),
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.guildId) return interaction.editReply({ content: '♡ play inside a server!' });
    try {
      const pool = getPaymentPool();
      const ids = { guildId: interaction.guildId, userId: interaction.user.id, game: 'wordle' };
      const status = await getGameCooldown(pool, ids);
      if (status.cooldown) return interaction.editReply({
        embeds: [embed(`♡ play again <t:${Math.ceil(status.nextPlay / 1000)}:R>`)],
      });
      const word = WORDS[randomInt(WORDS.length)];
      const session = randomUUID().slice(0, 12);
      const used = new Set();
      const history = [];
      let won = false;
      let timedOut = false;
      for (let attempt = 0; attempt < 6 && !won; attempt++) {
        const options = WORDS.filter(w => !used.has(w));
        if (!options.length) break;
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder().setCustomId(`cw_${session}_${attempt}`)
            .setPlaceholder(`Guess ${attempt + 1} of 6 · choose a word`)
            .addOptions(options.map(w => ({ label: w, value: w }))),
        );
        const message = await interaction.editReply({
          embeds: [embed('♡ Guess the secret five-letter word!\n' +
            '🟩 right spot  🟨 wrong spot  ⬛ not in word\n' +
            '♡ Pick from the 25-word list. You have 45 seconds per guess.\n\n' +
            (history.join('\n') || '*No guesses yet*'))],
          components: [row],
        });
        let selected;
        try {
          selected = await message.awaitMessageComponent({
            time: 45_000,
            filter: i => i.user.id === interaction.user.id &&
              i.customId === `cw_${session}_${attempt}`,
          });
        } catch {
          timedOut = true;
          break;
        }
        await selected.deferUpdate();
        const guess = selected.values?.[0];
        if (!WORDS.includes(guess) || used.has(guess)) {
          timedOut = true;
          break;
        }
        used.add(guess);
        history.push(`**${guess}**  ${score(word, guess)}`);
        won = guess === word;
      }
      const result = await settleMinigame(pool, {
        ...ids, interactionId: interaction.id, won,
      });
      if (result.cooldown) return interaction.editReply({
        embeds: [embed(`♡ already completed. play again <t:${Math.ceil(result.nextPlay / 1000)}:R>`)],
        components: [],
      });
      await interaction.editReply({
        embeds: [embed(`${won ? '🎀 you found the word!' : timedOut ? '♡ time ran out!' : '♡ out of guesses!'}\n` +
          `♡ secret word: **${word}**\n\n${history.join('\n')}\n\n` +
          `${UNICOIN_EMOJI} earned: **${result.earned}**\n` +
          `✨ XP: **+${result.xpEarned}**\n` +
          `♡ wallet: **${result.wallet.toLocaleString()}**\n` +
          `♡ games today: **${result.dailyMinigameCoins}/1,500**\n` +
          `♡ next wordle: <t:${Math.ceil(result.nextPlay / 1000)}:R>`)],
        components: [],
      });
    } catch (error) {
      console.error('[CUNVRS WORDLE]', error);
      await interaction.editReply({
        embeds: [embed('♡ game result could not be confirmed. Check your balance before trying again.')],
        components: [],
      }).catch(() => {});
    }
  },
};
