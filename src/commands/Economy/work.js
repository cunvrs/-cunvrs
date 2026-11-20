import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';
import { botConfig } from '../../config/bot.js';
import { getCareer, careerRank } from './modules/careers.js';

const COOLDOWN = botConfig.economy?.cooldowns?.work ?? 30 * 60 * 1000;
const TIME_LIMIT = 30_000;
const DAILY_LIMIT = 10;
const locks = new Set();
const embed = (title, description) => new EmbedBuilder().setColor(0xf6b7d2).setTitle(title).setDescription(description);
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

export default {
  data: new SlashCommandBuilder().setName('work').setDescription('🎀 Work and earn unicoins!')
    .addStringOption(o => o.setName('mode').setDescription('Choose your shift').addChoices({ name: '♡ Quick Work', value: 'quick' }, { name: '🎀 Interactive Work', value: 'interactive' })),
  async execute(interaction, config, client) {
    const guildId = interaction.guildId, userId = interaction.user.id;
    const key = `${guildId}:${userId}`;
    const say = (message) => interaction.reply({ embeds: [embed('🎀 ⋮ cunvrs. work!', message)], ephemeral: true });
    if (locks.has(key)) return say('☁️ you already have a shift in progress!');
    locks.add(key);
    try {
      const user = await getEconomyData(client, guildId, userId);
      const job = getCareer(user.careerJob);
      if (!job) return await say('♡ choose your career first with `/jobs list` and `/jobs apply`!');
      const now = Date.now();
      if (now < (user.workPendingUntil || 0)) return await say('☁️ your previous shift is still active. try again shortly!');
      const remaining = (user.lastWork || 0) + COOLDOWN - now;
      if (remaining > 0) return await say(`♡ rest up! you can work again <t:${Math.ceil(((user.lastWork || 0) + COOLDOWN) / 1000)}:R>.`);
      const today = new Date(now).toISOString().slice(0, 10);
      const shiftsToday = user.workDay === today ? (user.workDayCount || 0) : 0;
      if (shiftsToday >= DAILY_LIMIT) return await say('♡ you have completed all 10 shifts for today! come back tomorrow (UTC).');
      const mode = interaction.options.getString('mode') || 'quick';
      const task = job.tasks[rand(0, job.tasks.length - 1)];
      const pay = rand(job.minPay, job.maxPay);
      const session = randomUUID().slice(0, 12);
      // Reserve a shift before waiting for Discord buttons. This persists across restarts.
      user.workPendingUntil = now + TIME_LIMIT + 10_000;
      if (!await setEconomyData(client, guildId, userId, user)) return await say('☁️ could not save your shift. try again!');
      let correct = null;
      if (mode === 'interactive') {
        const row = new ActionRowBuilder().addComponents(task.options.map((option, i) => new ButtonBuilder().setCustomId(`cw:${session}:${i}`).setLabel(option).setStyle(ButtonStyle.Secondary)));
        const response = await interaction.reply({ embeds: [embed(`${job.emoji} ⋮ ${job.name} shift!`, `${task.question}\n\n♡ choose an answer within 30 seconds!`)], components: [row], ephemeral: true, fetchReply: true });
        try {
          const click = await response.awaitMessageComponent({ time: TIME_LIMIT, filter: i => i.user.id === userId && i.customId.startsWith(`cw:${session}:`) });
          correct = Number(click.customId.split(':')[2]) === task.correct;
          await click.deferUpdate();
        } catch {
          const expired = await getEconomyData(client, guildId, userId);
          if (expired.workPendingUntil === now + TIME_LIMIT + 10_000) {
            expired.workPendingUntil = 0;
            await setEconomyData(client, guildId, userId, expired);
          }
          await interaction.editReply({ embeds: [embed('☁️ shift expired', 'you ran out of time! no unicoins were awarded.')], components: [] });
          return;
        }
      }
      const earnedBase = mode === 'quick' ? Math.floor(pay * .7) : correct ? Math.floor(pay * 1.1) : Math.floor(pay * .5);
      const rank = careerRank(user.careerShifts || 0);
      const earned = Math.floor(earnedBase * (1 + rank.bonus));
      const xp = mode === 'quick' ? 10 : correct ? 30 : 10;
      const latest = await getEconomyData(client, guildId, userId);
      // A timed-out reservation cannot be completed after another shift has started.
      if (latest.workPendingUntil !== now + TIME_LIMIT + 10_000) {
        return await interaction.editReply({ embeds: [embed('☁️ shift cancelled', 'your shift reservation changed. no unicoins were awarded.')], components: [] });
      }
      latest.wallet = (latest.wallet || 0) + earned;
      latest.lastWork = Date.now();
      latest.workPendingUntil = 0;
      latest.careerXp = (latest.careerXp || 0) + xp;
      latest.careerShifts = (latest.careerShifts || 0) + 1;
      latest.workDay = today;
      latest.workDayCount = shiftsToday + 1;
      if (!await setEconomyData(client, guildId, userId, latest)) {
        return await interaction.editReply({ embeds: [embed('☁️ save failed', 'your shift could not be saved. contact staff if this persists.')], components: [] });
      }
      const result = mode === 'quick' ? 'quick shift completed!' : correct ? 'perfect shift!' : 'shift completed — reduced pay!';
      await interaction.editReply({ embeds: [embed(`🎀 ⋮ ${result}`, `${job.emoji} **${job.name}** · ${rank.name}\n\n💗 **+${earned.toLocaleString()} unicoins**\n✨ **+${xp} career XP**\n♡ wallet: **${latest.wallet.toLocaleString()} unicoins**\n♡ next shift: <t:${Math.ceil((latest.lastWork + COOLDOWN) / 1000)}:R>`) ], components: [] });
    } catch (error) {
      console.error('[CUNVRS WORK]', error);
      const payload = { embeds: [embed('☁️ shift error', 'something went wrong. please try again later!')], components: [], ephemeral: true };
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    } finally {
      locks.delete(key);
    }
  },
};
