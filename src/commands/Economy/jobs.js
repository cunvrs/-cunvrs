
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { CAREERS, getCareer, careerRank } from './modules/careers.js';
import { getPaymentPool } from './modules/paymentHandler.js';
import { UNICOIN_EMOJI } from '../../utils/wallet.js';

const PINK = 0xFFEDF4;

function makeEmbed(description) {
  return new EmbedBuilder()
    .setColor(PINK)
    .setDescription(
      `## ${UNICOIN_EMOJI} ⋮ **__cunvrs. careers!__**\n\n` +
      description
    )
    .setFooter({ text: 'cunvrs. economy' });
}

export default {
  data: new SlashCommandBuilder()
    .setName('jobs')
    .setDescription('Explore and manage your cunvrs. career')
    .addSubcommand(sub =>
      sub.setName('list').setDescription('Browse available jobs')
    )
    .addSubcommand(sub =>
      sub.setName('apply')
        .setDescription('Choose a career')
        .addStringOption(option =>
          option.setName('job')
            .setDescription('Your new career')
            .setRequired(true)
            .addChoices(
              ...CAREERS.map(job => ({
                name: job.name,
                value: job.id,
              }))
            )
        )
    )
    .addSubcommand(sub =>
      sub.setName('profile').setDescription('See your career progress')
    )
    .addSubcommand(sub =>
      sub.setName('quit').setDescription('Leave your current job')
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    const sub = interaction.options.getSubcommand();

    const reply = async text =>
      interaction.editReply({ embeds: [makeEmbed(text)] });

    if (!guildId) {
      return reply('♡ careers are only available inside a server!');
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
         VALUES ($1) ON CONFLICT (id) DO NOTHING`,
        [guildId]
      );

      await db.query(
        `INSERT INTO users (id)
         VALUES ($1) ON CONFLICT (id) DO NOTHING`,
        [userId]
      );

      await db.query(
        `INSERT INTO economy
           (guild_id, user_id, balance, bank, data)
         VALUES (
           $1, $2, 0, 0,
           '{"wallet":0,"bank":0,"level":1}'::jsonb
         )
         ON CONFLICT (guild_id, user_id) DO NOTHING`,
        [guildId, userId]
      );

      const result = await db.query(
        `SELECT data FROM economy
         WHERE guild_id = $1 AND user_id = $2
         FOR UPDATE`,
        [guildId, userId]
      );

      const data = result.rows[0].data || {};
      const level = Number(data.level ?? 1);
      const current = getCareer(data.careerJob);
      const shifts = Number(data.careerShifts || 0);

      let message;

      if (sub === 'list') {
        message = CAREERS.map(job =>
          `${job.emoji} **${job.name}** — ` +
          `level ${job.level} · ` +
          `${job.minPay}–${job.maxPay} Unicoins ` +
          `${level >= job.level ? '♡' : '🔒'}`
        ).join('\n');

      } else if (sub === 'profile') {
        message = current
          ? `${current.emoji} **${current.name}**\n\n` +
            `♡ career XP: **${data.careerXp || 0}**\n` +
            `♡ completed shifts: **${shifts}**\n` +
            `♡ rank: **${careerRank(shifts).name}**`
          : '♡ you are unemployed! use `/jobs apply` to start a career.';

      } else if (Number(data.workPendingUntil || 0) > Date.now()) {
        message = '♡ finish your current shift before changing jobs!';

      } else if (sub === 'quit') {
        if (!current) {
          message = '♡ you do not have a job yet!';
        } else {
          await db.query(
            `UPDATE economy
             SET data = jsonb_set(
               COALESCE(data, '{}'::jsonb),
               '{careerJob}',
               'null'::jsonb,
               true
             ),
             updated_at = CURRENT_TIMESTAMP
             WHERE guild_id = $1 AND user_id = $2`,
            [guildId, userId]
          );

          message =
            '♡ you left your job! your career XP and shifts are saved.';
        }

      } else if (sub === 'apply') {
        const job = getCareer(
          interaction.options.getString('job')
        );

        if (!job || level < job.level) {
          message = '🔒 you have not unlocked that career yet!';
        } else if (current?.id === job.id) {
          message = '♡ you already have this career!';
        } else {
          await db.query(
            `UPDATE economy
             SET data = jsonb_set(
               COALESCE(data, '{}'::jsonb),
               '{careerJob}',
               to_jsonb($3::text),
               true
             ),
             updated_at = CURRENT_TIMESTAMP
             WHERE guild_id = $1 AND user_id = $2`,
            [guildId, userId, job.id]
          );

          message =
            `${job.emoji} you are now a **${job.name}**!\n\n` +
            '♡ use `/work` to start your shift!';
        }
      } else {
        throw new Error('Unknown career action.');
      }

      await db.query('COMMIT');
      inTransaction = false;

      return await reply(message);

    } catch (error) {
      if (inTransaction && db) {
        await db.query('ROLLBACK').catch(() => {});
      }

      console.error('[CUNVRS JOBS]', error.message);

      return await reply(
        '♡ your career could not be updated. please try again later!'
      ).catch(() => {});

    } finally {
      db?.release();
    }
  },
};
