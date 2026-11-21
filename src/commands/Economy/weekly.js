
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { createHash } from 'node:crypto';
import { getPaymentPool } from './modules/paymentHandler.js';
import { UNICOIN_EMOJI } from '../../utils/wallet.js';

const PINK = 0xFFEDF4;
const REWARD = 2000;
const COOLDOWN = 7 * 24 * 60 * 60 * 1000;

function makeEmbed(description) {
  return new EmbedBuilder()
    .setColor(PINK)
    .setDescription(description)
    .setFooter({ text: 'cunvrs. economy' });
}

function operationId(interactionId) {
  const hash = createHash('sha256')
    .update(`cunvrs:weekly:${interactionId}`)
    .digest('hex');

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    '8' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

export default {
  data: new SlashCommandBuilder()
    .setName('weekly')
    .setDescription('Claim 2,000 Unicoins every seven days!'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    const userId = interaction.user.id;

    if (!guildId) {
      await interaction.editReply({
        content: '♡ weekly rewards are only available in servers!',
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
        throw new Error('Economy schema v2 is required.');
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
           '{"wallet":0,"bank":0,"level":1}'::jsonb
         )
         ON CONFLICT (guild_id, user_id) DO NOTHING`,
        [guildId, userId]
      );

      const result = await db.query(
        `SELECT balance, data
         FROM economy
         WHERE guild_id = $1 AND user_id = $2
         FOR UPDATE`,
        [guildId, userId]
      );

      if (result.rows.length !== 1) {
        throw new Error('Weekly account not found.');
      }

      const row = result.rows[0];
      const data = row.data || {};

      const wallet = Number(row.balance);
      const storedWallet = Number(data.wallet ?? row.balance);
      const lastWeekly = Number(data.lastWeekly ?? 0);
      const now = Date.now();

      if (
        !Number.isSafeInteger(wallet) ||
        wallet < 0 ||
        !Number.isSafeInteger(storedWallet) ||
        wallet !== storedWallet ||
        !Number.isSafeInteger(lastWeekly) ||
        lastWeekly < 0
      ) {
        throw new Error('Invalid wallet or cooldown data.');
      }

      const nextClaim = lastWeekly + COOLDOWN;

      if (lastWeekly > 0 && now < nextClaim) {
        await db.query('ROLLBACK');
        inTransaction = false;

        await interaction.editReply({
          embeds: [
            makeEmbed(
              `## ${UNICOIN_EMOJI} ⋮ **__weekly rewards!__**\n\n` +
              '♡ you already claimed your weekly reward!\n\n' +
              `🎀 **claim again:** <t:${Math.ceil(nextClaim / 1000)}:R>`
            ),
          ],
        });
        return;
      }

      const newWallet = wallet + REWARD;

      if (!Number.isSafeInteger(newWallet)) {
        throw new Error('Wallet exceeds safe integer range.');
      }

      const updatedData = {
        ...data,
        wallet: newWallet,
        lastWeekly: now,
      };

      await db.query(
        `UPDATE economy
         SET balance = $3,
             data = $4::jsonb,
             updated_at = CURRENT_TIMESTAMP
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId, newWallet, JSON.stringify(updatedData)]
      );

      await db.query(
        `INSERT INTO cunvrs_economy_ledger
           (
             operation_id, guild_id, user_id,
             actor_id, event_type, amount,
             balance_before, balance_after, details
           )
         VALUES
           (
             $1, $2, $3, $3, 'weekly_reward',
             $4, $5, $6, $7::jsonb
           )`,
        [
          operationId(interaction.id),
          guildId,
          userId,
          REWARD,
          wallet,
          newWallet,
          JSON.stringify({ cooldownDays: 7 }),
        ]
      );

      await db.query('COMMIT');
      inTransaction = false;

      await interaction.editReply({
        embeds: [
          makeEmbed(
            `## ${UNICOIN_EMOJI} ⋮ **__weekly claimed!__**\n\n` +
            '♡ your weekly reward has arrived!\n\n' +
            `${UNICOIN_EMOJI} **earned:** ${REWARD.toLocaleString()}\n` +
            `♡ **wallet:** ${newWallet.toLocaleString()}\n\n` +
            `🎀 **next weekly:** <t:${Math.ceil((now + COOLDOWN) / 1000)}:R>`
          ),
        ],
      });

    } catch (error) {
      if (inTransaction && db) {
        await db.query('ROLLBACK').catch(() => {});
      }

      console.error('[CUNVRS WEEKLY]', error);

      await interaction.editReply({
        embeds: [
          makeEmbed(
            `## ${UNICOIN_EMOJI} ⋮ **__weekly unavailable!__**\n\n` +
            '♡ your reward could not be confirmed. ' +
            'please check your balance before trying again.'
          ),
        ],
      }).catch(() => {});

    } finally {
      db?.release();
    }
  },
};
