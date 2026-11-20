import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';
import { CAREERS, getCareer, careerRank } from './modules/careers.js';

export default {
  data: new SlashCommandBuilder().setName('jobs').setDescription('🎀 Explore and manage your cunvrs. career')
    .addSubcommand(s => s.setName('list').setDescription('Browse available jobs'))
    .addSubcommand(s => s.setName('apply').setDescription('Choose a career').addStringOption(o => o.setName('job').setDescription('Your new career').setRequired(true).addChoices(...CAREERS.map(j => ({ name: j.name, value: j.id })))))
    .addSubcommand(s => s.setName('profile').setDescription('See your career progress'))
    .addSubcommand(s => s.setName('quit').setDescription('Leave your current job')),
  async execute(interaction, config, client) {
    const user = await getEconomyData(client, interaction.guildId, interaction.user.id);
    const sub = interaction.options.getSubcommand();
    const level = user.level || 1;
    const current = getCareer(user.careerJob);
    const reply = (description) => interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf6b7d2).setTitle('🎀 ⋮ cunvrs. careers!').setDescription(description)], ephemeral: true });
    if (sub === 'list') return reply(CAREERS.map(j => `${j.emoji} **${j.name}** — level ${j.level} · ${j.minPay}–${j.maxPay} unicoins ${level >= j.level ? '♡' : '🔒'}`).join('\n'));
    if (sub === 'profile') return reply(current ? `${current.emoji} **${current.name}**\n♡ career XP: **${user.careerXp || 0}**\n♡ completed shifts: **${user.careerShifts || 0}**\n♡ rank: **${careerRank(user.careerShifts || 0).name}**` : 'you are unemployed! use `/jobs list` and `/jobs apply`.');
    if (user.workPendingUntil > Date.now()) return reply('☁️ finish your current shift before changing jobs!');
    if (sub === 'quit') {
      if (!current) return reply('you do not have a job yet!');
      user.careerJob = null;
      user.careerXp = 0;
      user.careerShifts = 0;
      if (!await setEconomyData(client, interaction.guildId, interaction.user.id, user)) return reply('could not save your changes. try again!');
      return reply('♡ you left your job! your career progress was reset.');
    }
    const job = getCareer(interaction.options.getString('job'));
    if (!job || level < job.level) return reply('🔒 you have not unlocked that job yet!');
    if (current?.id === job.id) return reply('♡ you already have this job!');
    user.careerJob = job.id;
    user.careerXp = 0;
    user.careerShifts = 0;
    if (!await setEconomyData(client, interaction.guildId, interaction.user.id, user)) return reply('could not save your changes. try again!');
    return reply(`${job.emoji} you are now a **${job.name}**! use \`/work\` to start a shift. ♡`);
  },
};
