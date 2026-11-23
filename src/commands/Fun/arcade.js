import { randomInt } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType,
  EmbedBuilder, MessageFlags, SlashCommandBuilder,
} from 'discord.js';
import { logger } from '../../utils/logger.js';

const MAX_STAKE = 1000;
const symbols = ['🎀 Ribbon', '🍓 Berry', '🌙 Moon', '🧁 Cupcake', '✨ Star'];
const fortunes = [
  'A tiny win is waiting in a place you usually scroll past.',
  'Your luck improves after a snack break.',
  'A friend is about to send you something wildly specific.',
  'The moon recommends wearing your favorite color today.',
  'Your next side quest has excellent soundtrack potential.',
];

const addStake = sub => sub.addIntegerOption(option => option
  .setName('stake')
  .setDescription('Play points for this round (1 to 1,000, default 10)')
  .setMinValue(1)
  .setMaxValue(MAX_STAKE));

const games = {
  slots: { title: '🎰 Ribbon Reels', prompt: 'Match two symbols for 2× or three for 6×.', buttons: [['spin', 'Spin the reels', '🎰']] },
  coinflip: { title: '🪙 Moon & Ribbon', prompt: 'Choose a side and flip the coin.', buttons: [['moon', 'Moon', '🌙'], ['ribbon', 'Ribbon', '🎀']] },
  highlow: { title: '🃏 Lucky Seven', prompt: 'Your starting card is **7**. Will the next card be higher or lower?', buttons: [['high', 'Higher', '⬆️'], ['low', 'Lower', '⬇️']] },
  fortune: { title: '🥠 Your tiny fortune', prompt: 'A warm cookie is waiting for you.', buttons: [['open', 'Crack the cookie', '🥠']] },
};

function card(title, description, footer) {
  return new EmbedBuilder({ color: 0xFFEDF4, title, description, footer: { text: footer } });
}

function play(game, pick, stake) {
  let multiplier;
  let result;
  if (game === 'fortune') return fortunes[randomInt(fortunes.length)];
  if (game === 'slots') {
    const reels = Array.from({ length: 3 }, () => symbols[randomInt(symbols.length)]);
    const unique = new Set(reels).size;
    multiplier = unique === 1 ? 6 : unique === 2 ? 2 : 0;
    result = reels.join('  │  ');
  } else if (game === 'coinflip') {
    const side = randomInt(2) === 0 ? 'moon' : 'ribbon';
    multiplier = pick === side ? 2 : 0;
    result = side === 'moon' ? '🌙 The coin landed on **Moon**!' : '🎀 The coin landed on **Ribbon**!';
  } else {
    const draw = randomInt(1, 14);
    multiplier = draw === 7 ? 1 : (draw > 7) === (pick === 'high') ? 2 : 0;
    result = `🃏 Starting card **7** → drawn card **${draw}**`;
  }
  const change = stake * (multiplier - 1);
  const score = change === 0 ? '♡ Tie! Your stake is returned.' :
    `♡ **${change > 0 ? '+' : '−'}${Math.abs(change)} play points**`;
  return `${result}\n\n${score}`;
}

export default {
  data: new SlashCommandBuilder()
    .setName('arcade')
    .setDescription('Play a quick round at the Cunvrs arcade')
    .addSubcommand(sub => addStake(sub.setName('slots')
      .setDescription('Spin three reels and match cute symbols')))
    .addSubcommand(sub => addStake(sub.setName('coinflip')
      .setDescription('Call the moon or the ribbon')))
    .addSubcommand(sub => addStake(sub.setName('highlow')
      .setDescription('Guess whether the next card beats a seven')))
    .addSubcommand(sub => sub.setName('fortune')
      .setDescription('Open a tiny fortune cookie')),

  async execute(interaction) {
    const game = interaction.options.getSubcommand();
    const { title, prompt, buttons } = games[game];
    const stake = game === 'fortune' ? 0 : interaction.options.getInteger('stake') ?? 10;
    if (game !== 'fortune' && (!Number.isSafeInteger(stake) || stake < 1 || stake > MAX_STAKE)) {
      await interaction.reply({ content: '♡ Pick a stake between 1 and 1,000 play points.' });
      return;
    }

    const prefix = `arcade:${interaction.id}:`;
    const row = new ActionRowBuilder().addComponents(buttons.map(([id, label, emoji]) =>
      new ButtonBuilder().setCustomId(prefix + id).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Secondary)
    ));
    const summary = stake ? `\n\n♡ Stake: **${stake} play points**` : '';
    await interaction.reply({
      embeds: [card(title, prompt + summary, 'Pick a button within 60 seconds')],
      components: [row],
    });
    const message = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60_000,
      max: 1,
      filter(button) {
        if (!buttons.some(([id]) => button.customId === prefix + id)) return false;
        if (button.user.id === interaction.user.id) return true;
        void button.reply({ content: '♡ Start your own round with /arcade.', flags: MessageFlags.Ephemeral }).catch(() => {});
        return false;
      },
    });
    collector.on('collect', button => {
      const result = play(game, button.customId.slice(prefix.length), stake);
      void button.update({
        embeds: [card(title, result, 'Round complete · play points reset each round')],
        components: [],
      }).catch(error => logger.warn('Could not display arcade result', { error: error.message }));
    });
    collector.on('end', collected => {
      if (collected.size) return;
      void interaction.editReply({
        embeds: [card(title, '♡ This round closed. Start another with /arcade.', 'Round expired')],
        components: [],
      }).catch(() => {});
    });
  },
};
