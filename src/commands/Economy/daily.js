
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { createHash } from 'node:crypto';

import { getPaymentPool } from './modules/paymentHandler.js';
import { UNICOIN_EMOJI } from '../../utils/wallet.js';

const PINK = 0xFFEDF4;

const DAY = 24 * 60 * 60 * 1000;
const BASE_REWARD = 400;
const STREAK_BONUS = 50;
const MAX_REWARD = 1000;

function embed(description) {
  return new EmbedBuilder()
    .setColor(PINK)
    .setDescription(description)
    .setFooter({ text: 'cunvrs. economy' });
}

function operationId(interactionId) {
  const hex = createHash('sha256')
    .update(`cunvrs:daily:${interactionId}`)
    .digest('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    '4' + hex.slice(13, 16),
    '8' + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

export default {
  data: new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily Unicoin reward!'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    const userId = interaction.user.id;

    if (!guildId) {
      await interaction.editReply({
        content: '♡ you can only claim daily rewards in a server!',
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

      const account = await db.query(
        `SELECT balance, data
         FROM economy
         WHERE guild_id = $1 AND user_id = $2
         FOR UPDATE`,
        [guildId, userId]
      );

      if (account.rows.length !== 1) {
        throw new Error('Could not load daily account.');
      }

      const row = account.rows[0];
      const data = row.data || {};

      const now = Date.now();
      const lastDaily = Number(data.lastDaily ?? 0);
      const previousStreak = Number(data.dailyStreak ?? 0);
      const wallet = Number(data.wallet ?? row.balance);

      if (
        !Number.isSafeInteger(lastDaily) ||
        lastDaily < 0 ||
        !Number.isSafeInteger(previousStreak) ||
        previousStreak < 0 ||
        !Number.isSafeInteger(wallet) ||
        wallet < 0 ||
        !Number.isSafeInteger(Number(row.balance)) ||
        Number(row.balance) !== wallet
      ) {
        throw new Error('Invalid stored daily or wallet data.');
      }

      const nextClaim = lastDaily + DAY;

      if (lastDaily > 0 && now < nextClaim) {
        await db.query('ROLLBACK');
        inTransaction = false;

        await interaction.editReply({
          embeds: [
            embed(
              `## ${UNICOIN_EMOJI} ⋮ **__daily rewards!__**\n\n` +
              '♡ you already claimed your daily reward!\n\n' +
              `🎀 **current streak:** ${previousStreak} days\n` +
              `♡ **claim again:** <t:${Math.ceil(nextClaim / 1000)}:R>`
            ),
          ],
        });
        return;
      }

      const continued =
        lastDaily > 0 &&
        now >= nextClaim &&
        now < lastDaily + (DAY * 2);

      const streak = continued ? previousStreak + 1 : 1;

      const reward = Math.min(
        MAX_REWARD,
        BASE_REWARD + (streak - 1) * STREAK_BONUS
      );

      const newWallet = wallet + reward;

      if (!Number.isSafeInteger(newWallet)) {
        throw new Error('Wallet exceeds safe integer range.');
      }

      // Update the balance and profile under the same row lock.
      const updatedData = {
        ...data,
        wallet: newWallet,
        lastDaily: now,
        dailyStreak: streak,
      };

      await db.query(
        `UPDATE economy
         SET balance = $3,
             data = $4::jsonb,
             updated_at = CURRENT_TIMESTAMP
         WHERE guild_id = $1 AND user_id = $2`,
        [guildId, userId, newWallet, JSON.stringify(updatedData)]
      );

      // Every successful award is recorded in the economy ledger.
      await db.query(
        `INSERT INTO cunvrs_economy_ledger
          (
            operation_id,
            guild_id,
            user_id,
            actor_id,
            event_type,
            amount,
            balance_before,
            balance_after,
            details
          )
         VALUES
          (
            $1, $2, $3, $3, 'daily_reward',
            $4, $5, $6, $7::jsonb
          )`,
        [
          operationId(interaction.id),
          guildId,
          userId,
          reward,
          wallet,
          newWallet,
          JSON.stringify({ streak }),
        ]
      );

      await db.query('COMMIT');
      inTransaction = false;

      await interaction.editReply({
        embeds: [
          embed(
            `## ${UNICOIN_EMOJI} ⋮ **__daily claimed!__**\n\n` +
            '♡ your daily reward has arrived!\n\n' +
            `${UNICOIN_EMOJI} **earned:** ${reward.toLocaleString()}\n` +
            `🎀 **streak:** ${streak} day${streak === 1 ? '' : 's'}\n` +
            `♡ **wallet:** ${newWallet.toLocaleString()}\n\n` +
            `♡ **next daily:** <t:${Math.ceil((now + DAY) / 1000)}:R>` +
            (reward === MAX_REWARD
              ? '\n\n✨ **maximum daily reward unlocked!**'
              : '')
          ),
        ],
      });

    } catch (error) {
      if (inTransaction && db) {
        await db.query('ROLLBACK').catch(() => {});
      }

      console.error('[CUNVRS DAILY]', error);

      await interaction.editReply({
        embeds: [
          embed(
            `## ${UNICOIN_EMOJI} ⋮ **__daily unavailable!__**\n\n` +
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
