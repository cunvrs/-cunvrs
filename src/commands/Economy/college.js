
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

import { randomUUID } from 'node:crypto';
import { getPaymentPool } from './modules/paymentHandler.js';

const PINK = 0xFFEDF4;
const activeExams = new Set();

const QUESTIONS = [
  {
    question: 'What is 15 × 4?',
    answers: ['45', '60', '75'],
    correct: 1,
  },
  {
    question: 'Which planet is closest to the Sun?',
    answers: ['Venus', 'Earth', 'Mercury'],
    correct: 2,
  },
  {
    question: 'A shop earns 500 Unicoins and spends 175. What remains?',
    answers: ['325', '375', '425'],
    correct: 0,
  },
];

function makeEmbed(description) {
  return new EmbedBuilder()
    .setColor(PINK)
    .setDescription(description)
    .setFooter({ text: 'cunvrs. college' });
}

export default {
  data: new SlashCommandBuilder()
    .setName('college')
    .setDescription('Take your college entrance exam at 100 IQ!'),

  async execute(interaction, config, client) {
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const key = `${guildId}:${userId}`;

    if (activeExams.has(key)) {
      await interaction.reply({
        content: '♡ you already have an exam in progress!',
        ephemeral: true,
      });
      return;
    }

    activeExams.add(key);

    try {
      await interaction.deferReply({ ephemeral: true });

      if (!guildId) {
        throw new Error('College is only available in a server.');
      }

      const pool = getPaymentPool();

      const version = await pool.query(
        'SELECT MAX(version) AS version FROM schema_migrations'
      );

      if (Number(version.rows[0]?.version) !== 2) {
        throw new Error('Economy database version 2 is required.');
      }

      const account = await pool.query(
        `SELECT data FROM economy
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId]
      );

      const data = account.rows[0]?.data || {};

      if (data.collegeGraduated) {
        await interaction.editReply({
          embeds: [makeEmbed(
            '## 🎓 ⋮ **__college!__**\n\n' +
            '♡ you already graduated! congratulations!'
          )],
        });
        return;
      }

      if (Number(data.iq || 0) < 100) {
        await interaction.editReply({
          embeds: [makeEmbed(
            '## 🎓 ⋮ **__college!__**\n\n' +
            `♡ you need **100 IQ** to enroll!\n\n` +
            `🧠 **your IQ:** ${Number(data.iq || 0)}/100\n\n` +
            'use `/study` to prepare for college!'
          )],
        });
        return;
      }

      let score = 0;
      const sessionId = randomUUID().slice(0, 12);

      for (let index = 0; index < QUESTIONS.length; index++) {
        const question = QUESTIONS[index];

        const buttons = new ActionRowBuilder().addComponents(
          question.answers.map((answer, answerIndex) =>
            new ButtonBuilder()
              .setCustomId(`college:${sessionId}:${index}:${answerIndex}`)
              .setLabel(answer)
              .setStyle(ButtonStyle.Secondary)
          )
        );

        const message = await interaction.editReply({
          embeds: [makeEmbed(
            `## 🎓 ⋮ **__college entrance exam!__**\n\n` +
            `**question ${index + 1}/3**\n\n` +
            `${question.question}\n\n` +
            '♡ you have 30 seconds to answer!'
          )],
          components: [buttons],
        });

        let clicked;

        try {
          clicked = await message.awaitMessageComponent({
            time: 30_000,
            filter: button =>
              button.user.id === userId &&
              button.customId.startsWith(
                `college:${sessionId}:${index}:`
              ),
          });
        } catch {
          await interaction.editReply({
            embeds: [makeEmbed(
              '## 🎓 ⋮ **__exam expired!__**\n\n' +
              '♡ time ran out. your IQ was not changed.'
            )],
            components: [],
          });
          return;
        }

        await clicked.deferUpdate();

        const selected = Number(
          clicked.customId.split(':')[3]
        );

        if (selected === question.correct) {
          score++;
        }
      }

      const db = await pool.connect();

      try {
        await db.query('BEGIN');

        const locked = await db.query(
          `SELECT data FROM economy
           WHERE guild_id = $1 AND user_id = $2
           FOR UPDATE`,
          [guildId, userId]
        );

        if (locked.rows.length !== 1) {
          throw new Error('College profile not found.');
        }

        const latest = locked.rows[0].data || {};

        if (
          latest.collegeGraduated ||
          !Number.isSafeInteger(Number(latest.iq)) ||
          Number(latest.iq) < 100
        ) {
          throw new Error('College eligibility changed.');
        }

        const passed = score >= 2;

        const updated = {
          ...latest,
          collegeGraduated: passed,
          iq: passed ? Number(latest.iq) : 75,
        };

        await db.query(
          `UPDATE economy
           SET data = $3::jsonb,
               updated_at = CURRENT_TIMESTAMP
           WHERE guild_id = $1 AND user_id = $2`,
          [guildId, userId, JSON.stringify(updated)]
        );

        await db.query('COMMIT');

        await interaction.editReply({
          embeds: [makeEmbed(
            passed
              ? '## 🎓 ⋮ **__you graduated!__**\n\n' +
                `♡ you scored **${score}/3**!\n\n` +
                '🎀 **college diploma unlocked!**\n' +
                '♡ your new work bonus starts at **+15%**!'
              : '## 🎓 ⋮ **__exam unsuccessful!__**\n\n' +
                `♡ you scored **${score}/3**.\n\n` +
                '🧠 your IQ has been reduced to **75**.\n\n' +
                '♡ study again and retry when you reach 100 IQ!'
          )],
          components: [],
        });
      } catch (error) {
        await db.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        db.release();
      }

    } catch (error) {
      console.error('[CUNVRS COLLEGE]', error);

      const payload = {
        embeds: [makeEmbed(
          '## 🎓 ⋮ **__college unavailable!__**\n\n' +
          '♡ your exam could not be completed. please try again later!'
        )],
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
      activeExams.delete(key);
    }
  },
};
