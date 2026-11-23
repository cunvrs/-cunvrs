import { randomInt } from 'node:crypto';
import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';

const symbols = ['🎀', '🍓', '🌙', '🧁', '✨'];
const fortunes = [
  'A tiny win is waiting in a place you usually scroll past.',
  'Your luck improves after a snack break.',
  'A friend is about to send you something wildly specific.',
  'The moon recommends wearing your favorite color today.',
  'Your next side quest has excellent soundtrack potential.',
];

const addStake = sub => sub.addIntegerOption(option => option
  .setName('stake')
  .setDescription('Play points for this round (default 10)')
  .setMinValue(1)
  .setMaxValue(100));

export default {
  data: new SlashCommandBuilder()
    .setName('arcade')
    .setDescription('Play a quick round at the Cunvrs arcade')
    .addSubcommand(sub => addStake(sub.setName('slots')
      .setDescription('Spin three reels and match cute symbols')))
    .addSubcommand(sub => addStake(sub.setName('coinflip')
      .setDescription('Call the moon or the ribbon')
      .addStringOption(option => option.setName('pick')
        .setDescription('Which side will land face up?')
        .setRequired(true)
        .addChoices({ name: '🌙 Moon', value: 'moon' }, { name: '🎀 Ribbon', value: 'ribbon' }))))
    .addSubcommand(sub => addStake(sub.setName('highlow')
      .setDescription('Guess whether the next card beats a seven')
      .addStringOption(option => option.setName('pick')
        .setDescription('Call higher or lower than 7')
        .setRequired(true)
        .addChoices({ name: 'Higher', value: 'high' }, { name: 'Lower', value: 'low' }))))
    .addSubcommand(sub => sub.setName('fortune')
      .setDescription('Open a tiny fortune cookie')),

  async execute(interaction) {
    const game = interaction.options.getSubcommand();
    const card = new EmbedBuilder().setColor(0xFFEDF4);

    if (game === 'fortune') {
      card.setTitle('🥠 Your tiny fortune')
        .setDescription(fortunes[randomInt(fortunes.length)]);
      await interaction.reply({ embeds: [card] });
      return;
    }

    const stake = interaction.options.getInteger('stake') ?? 10;
    if (!Number.isSafeInteger(stake) || stake < 1 || stake > 100) {
      await interaction.reply({ content: '♡ Pick a stake between 1 and 100 play points.' });
      return;
    }

    let multiplier;
    let result;
    if (game === 'slots') {
      const reels = Array.from({ length: 3 }, () => symbols[randomInt(symbols.length)]);
      const unique = new Set(reels).size;
      multiplier = unique === 1 ? 6 : unique === 2 ? 2 : 0;
      result = reels.join('  │  ');
      card.setTitle('🎰 Ribbon Reels');
    } else {
      const pick = interaction.options.getString('pick')?.toLowerCase();
      const choices = game === 'coinflip' ? ['moon', 'ribbon'] : ['high', 'low'];
      if (!choices.includes(pick)) {
        await interaction.reply({ content: `♡ Pick ${choices.join(' or ')}.` });
        return;
      }
      if (game === 'coinflip') {
        const side = choices[randomInt(choices.length)];
        multiplier = pick === side ? 2 : 0;
        result = side === 'moon' ? '🌙 **Moon**' : '🎀 **Ribbon**';
        card.setTitle('🪙 Moon & Ribbon');
      } else {
        const draw = randomInt(1, 14);
        multiplier = draw === 7 ? 1 : (draw > 7) === (pick === 'high') ? 2 : 0;
        result = `Starting card **7** · next card **${draw}**`;
        card.setTitle('🃏 Lucky Seven');
      }
    }

    const change = stake * (multiplier - 1);
    const score = change === 0 ? '♡ Tie! Your stake is returned.' :
      `♡ ${change > 0 ? '+' : '−'}${Math.abs(change)} play points`;
    card.setDescription(`${result}\n\n${score}`)
      .setFooter({ text: 'Round score only · play points reset each round' });
    await interaction.reply({ embeds: [card] });
  },
};
