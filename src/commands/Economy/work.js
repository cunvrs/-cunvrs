
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

import { randomUUID, randomInt } from 'node:crypto';
import { getCareer } from './modules/careers.js';
import { awardWorkShift } from './modules/workRewards.js';
import { getPaymentPool } from './modules/paymentHandler.js';
import {
  UNICOIN_EMOJI,
  formatUnicoins,
} from '../../utils/wallet.js';

const PINK = 0xFFEDF4;
const TIME_LIMIT = 30_000;
const activeShifts = new Set();

function makeEmbed(description) {
  return new EmbedBuilder()
    .setColor(PINK)
    .setDescription(description)
    .setFooter({ text: 'cunvrs. economy' });
}

function formatError(error) {
  const message = String(error?.message || '');

  const safeMessages = [
    'Your career changed',
    'Your work cooldown',
    'Work shift already processed',
    'You have completed all 10 shifts',
    'Invalid work',
  ];

  if (safeMessages.some(text => message.includes(text))) {
    return message;
  }

  return 'your shift could not be completed. please try again later!';
}

export default {
  data: new SlashCommandBuilder()
    .setName('work')
    .setDescription('Work and earn Unicoins!')
    .addStringOption(option =>
      option
        .setName('mode')
        .setDescription('Choose your shift')
        .addChoices(
          { name: '♡ Quick Work', value: 'quick' },
          { name: '🎀 Interactive Work', value: 'interactive' }
        )
    ),

  async execute(interaction, config, client) {
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const key = `${guildId}:${userId}`;

    if (activeShifts.has(key)) {
      await interaction.reply({
        embeds: [
          makeEmbed(
            `## ${UNICOIN_EMOJI} ⋮ **__work!__**\n\n` +
            '♡ you already have a shift in progress!'
          ),
        ],
        ephemeral: true,
      });
      return;
    }

    activeShifts.add(key);

    try {
      await interaction.deferReply({ ephemeral: true });

      if (!guildId) {
        throw new Error('Work is available in servers only.');
      }

      const pool = getPaymentPool();

      const version = await pool.query(
        'SELECT MAX(version) AS version FROM schema_migrations'
      );

      if (Number(version.rows[0]?.version) !== 2) {
        throw new Error('Economy database version 2 is required.');
      }

      const account = await pool.query(
        `SELECT data
         FROM economy
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId]
      );

      const data = account.rows[0]?.data || {};
      const job = getCareer(data.careerJob);

      if (!job) {
        await interaction.editReply({
          embeds: [
            makeEmbed(
              `## ${UNICOIN_EMOJI} ⋮ **__work!__**\n\n` +
              '♡ choose your career first using `/jobs list` and `/jobs apply`!'
            ),
          ],
        });
        return;
      }

      const mode = interaction.options.getString('mode') || 'quick';
      const basePay = randomInt(job.minPay, job.maxPay + 1);

      let correct = null;

      if (mode === 'interactive') {
        const task = job.tasks[randomInt(job.tasks.length)];
        const sessionId = randomUUID().slice(0, 12);

        const row = new ActionRowBuilder().addComponents(
          task.options.map((answer, index) =>
            new ButtonBuilder()
              .setCustomId(`cw:${sessionId}:${index}`)
              .setLabel(answer)
              .setStyle(ButtonStyle.Secondary)
          )
        );

        const message = await interaction.editReply({
          embeds: [
            makeEmbed(
              `## ${UNICOIN_EMOJI} ⋮ **__${job.name.toLowerCase()} shift!__**\n\n` +
              `${task.question}\n\n` +
              '♡ choose an answer within **30 seconds**!'
            ),
          ],
          components: [row],
        });

        try {
          const clicked = await message.awaitMessageComponent({
            time: TIME_LIMIT,
            filter: button =>
              button.user.id === userId &&
              button.customId.startsWith(`cw:${sessionId}:`),
          });

          correct =
            Number(clicked.customId.split(':')[2]) === task.correct;

          await clicked.deferUpdate();
        } catch {
          await interaction.editReply({
            embeds: [
              makeEmbed(
                `## ${UNICOIN_EMOJI} ⋮ **__shift expired!__**\n\n` +
                '♡ time ran out! no Unicoins were awarded.'
              ),
            ],
            components: [],
          });
          return;
        }
      }

      const careerXp =
        mode === 'quick' ? 10 : correct ? 30 : 10;

      // The database transaction handles:
      // wallet, career XP, cooldown, daily caps and ledger.
      // CUNVRS_WORK_IDEMPOTENCY_V1
      const result = await awardWorkShift(pool, {
        guildId,
        userId,
        interactionId: interaction.id,
        job,
        mode,
        correct,
        basePay,
        careerXp,
      });

      const outcome =
        mode === 'quick'
          ? 'quick shift completed!'
          : correct
            ? 'perfect shift!'
            : 'shift completed!';

      const description =
        `## ${UNICOIN_EMOJI} ⋮ **__${outcome}__**\n\n` +
        `${job.emoji} **${job.name}** · ${result.rank}\n\n` +
        `${UNICOIN_EMOJI} **earned:** ${formatUnicoins(result.earned)}\n` +
        `✨ **career XP:** +${careerXp}\n` +
        `♡ **wallet:** ${formatUnicoins(result.wallet)}\n` +
        `♡ **shifts today:** ${result.shiftsToday}/10\n` +
        `♡ **daily earnings:** ${formatUnicoins(result.dailyEarned)} / 5,000\n` +
        `♡ **next shift:** <t:${Math.ceil(result.nextWork / 1000)}:R>` +
        (result.dailyCapReached
          ? '\n\n♡ you reached your daily earning limit!'
          : '');

      await interaction.editReply({
        embeds: [makeEmbed(description)],
        components: [],
      });
    } catch (error) {
      console.error('[CUNVRS WORK]', error);

      const payload = {
        embeds: [
          makeEmbed(
            `## ${UNICOIN_EMOJI} ⋮ **__shift unsuccessful!__**\n\n` +
            `♡ ${formatError(error)}`
          ),
        ],
        components: [],
      };

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply({
          ...payload,
          ephemeral: true,
        }).catch(() => {});
      }
    } finally {
      activeShifts.delete(key);
    }
  },
};
