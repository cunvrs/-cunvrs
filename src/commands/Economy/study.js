
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { randomInt } from 'node:crypto';

import { getPaymentPool } from './modules/paymentHandler.js';
import { UNICOIN_EMOJI } from '../../utils/wallet.js';
import {
  MAX_IQ,
  STUDY_COOLDOWN,
  STUDY_XP,
  addIq,
  addLevelXp,
} from '../../utils/progression.js';

const PINK = 0xFFEDF4;

function makeEmbed(description) {
  return new EmbedBuilder()
    .setColor(PINK)
    .setDescription(description)
    .setFooter({ text: 'cunvrs. economy' });
}

export default {
  data: new SlashCommandBuilder()
    .setName('study')
    .setDescription('Study to increase your IQ and earn XP!'),

  async execute(interaction, config, client) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    const userId = interaction.user.id;

    if (!guildId) {
      await interaction.editReply({
        content: '♡ you can only study inside a server!',
      });
      return;
    }

    const pool = getPaymentPool();
    let db;
    let inTransaction = false;

    try {
      db = await pool.connect();

      const version = await db.query(
        'SELECT MAX(version) AS version FROM schema_migrations'
      );

      if (Number(version.rows[0]?.version) !== 2) {
        throw new Error('Economy database version 2 is required.');
      }

      await db.query('BEGIN');
      inTransaction = true;

      await db.query(
        `INSERT INTO guilds (id)
         VALUES ($1)
         ON CONFLICT (id) DO NOTHING`,
        [guildId]
      );

      await db.query(
        `INSERT INTO users (id)
         VALUES ($1)
         ON CONFLICT (id) DO NOTHING`,
        [userId]
      );

      await db.query(
        `INSERT INTO economy
           (guild_id, user_id, balance, bank, data)
         VALUES (
           $1, $2, 0, 0,
           '{"wallet":0,"bank":0,"level":1,"xp":0,"iq":0}'::jsonb
         )
         ON CONFLICT (guild_id, user_id) DO NOTHING`,
        [guildId, userId]
      );

      const account = await db.query(
        `SELECT data
         FROM economy
         WHERE guild_id = $1 AND user_id = $2
         FOR UPDATE`,
        [guildId, userId]
      );

      if (account.rows.length !== 1) {
        throw new Error('Could not load your study profile.');
      }

      const data = account.rows[0].data || {};
      const now = Date.now();
      const lastStudy = Number(data.lastStudy || 0);

      if (
        !Number.isSafeInteger(lastStudy) ||
        lastStudy < 0
      ) {
        throw new Error('Invalid study cooldown.');
      }

      const nextAvailable = lastStudy + STUDY_COOLDOWN;

      if (now < nextAvailable) {
        await db.query('ROLLBACK');
        inTransaction = false;

        await interaction.editReply({
          embeds: [
            makeEmbed(
              `## 📚 ⋮ **__study time!__**\n\n` +
              `♡ you've already studied recently!\n\n` +
              `**study again:** <t:${Math.ceil(nextAvailable / 1000)}:R>`
            ),
          ],
        });
        return;
      }

      const currentIq = Number(data.iq ?? 0);
      const currentLevel = Number(data.level ?? 1);
      const currentXp = Number(data.xp ?? 0);

      if (
        !Number.isSafeInteger(currentIq) ||
        currentIq < 0 ||
        currentIq > MAX_IQ
      ) {
        throw new Error('Invalid stored IQ.');
      }

      const iqGained = randomInt(3, 6);
      const newIq = addIq(currentIq, iqGained);
      const actualIqGain = newIq - currentIq;

      const progression = addLevelXp(
        currentLevel,
        currentXp,
        STUDY_XP
      );

      const updated = {
        ...data,
        iq: newIq,
        level: progression.level,
        xp: progression.xp,
        lastStudy: now,
      };

      await db.query(
        `UPDATE economy
         SET data = $3::jsonb,
             updated_at = CURRENT_TIMESTAMP
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId, JSON.stringify(updated)]
      );

      await db.query('COMMIT');
      inTransaction = false;

      const description =
        `## 📚 ⋮ **__study completed!__**\n\n` +
        `♡ your studying paid off!\n\n` +
        `🧠 **IQ gained:** +${actualIqGain}\n` +
        `✨ **XP gained:** +${STUDY_XP}\n\n` +
        `♡ **current IQ:** ${newIq}/${MAX_IQ}\n` +
        `♡ **level:** ${progression.level}\n` +
        `♡ **XP:** ${progression.xp}/${progression.xpToNextLevel}\n` +
        `♡ **study again:** <t:${Math.ceil((now + STUDY_COOLDOWN) / 1000)}:R>` +
        (progression.levelsGained > 0
          ? `\n\n🎀 **level up!** you gained ${progression.levelsGained} level(s)!`
          : '') +
        (newIq >= 100 && !updated.collegeGraduated
          ? '\n\n🎓 **college is unlocked!**'
          : '') +
        (newIq === MAX_IQ
          ? '\n\n♡ you reached the maximum IQ!'
          : '');

      await interaction.editReply({
        embeds: [makeEmbed(description)],
      });

    } catch (error) {
      if (inTransaction && db) {
        await db.query('ROLLBACK').catch(() => {});
      }

      console.error('[CUNVRS STUDY]', error.message);

      await interaction.editReply({
        embeds: [
          makeEmbed(
            `## 📚 ⋮ **__study unavailable!__**\n\n` +
            '♡ your study session could not be saved. please try again later!'
          ),
        ],
      }).catch(() => {});

    } finally {
      db?.release();
    }
  },
};
