
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { createHash } from 'node:crypto';
import { getUserBirthday } from '../../../services/birthdayService.js';
import { getPaymentPool } from '../../Economy/modules/paymentHandler.js';
import { UNICOIN_EMOJI } from '../../../utils/wallet.js';

const REWARD = 1000;

const MONTHS = [
  'January', 'February', 'March', 'April',
  'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December',
];

function birthdayEmbed(message) {
  return new EmbedBuilder()
    .setColor(0xFFEDF4)
    .setDescription(
      `## 🎂 ⋮ **__birthday rewards!__**\n\n${message}`
    )
    .setFooter({ text: 'cunvrs. economy' });
}

function detroitToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Detroit',
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
  }).formatToParts(new Date());

  const get = type =>
    Number(parts.find(p => p.type === type)?.value);

  return {
    month: get('month'),
    day: get('day'),
    year: get('year'),
  };
}

function getBirthdayDate(birthday) {
  let month = Number(birthday.month);

  if (!Number.isInteger(month)) {
    month = MONTHS.findIndex(
      name => name.toLowerCase() ===
        String(birthday.monthName ?? '').toLowerCase()
    ) + 1;
  }

  const day = Number(birthday.day);

  if (
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31
  ) {
    throw new Error('Invalid registered birthday.');
  }

  return { month, day };
}

function claimOperationId(guildId, userId, year) {
  const hash = createHash('sha256')
    .update(`cunvrs:birthday:${guildId}:${userId}:${year}`)
    .digest('hex');

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

export default {
  async execute(interaction, config, client) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    const guildId = interaction.guildId;
    const userId = interaction.user.id;

    const respond = message =>
      interaction.editReply({
        embeds: [birthdayEmbed(message)],
      });

    if (!guildId) {
      return respond('♡ claim birthday rewards inside a server!');
    }

    try {
      const birthday = await getUserBirthday(
        client,
        guildId,
        userId
      );

      if (!birthday) {
        return respond(
          '♡ register your birthday with `/birthday set` first!'
        );
      }

      const registered = getBirthdayDate(birthday);
      const today = detroitToday();

      // Birthday rewards require a stable registration
      // for at least 30 full days.
      const WAITING_PERIOD = 30 * 24 * 60 * 60 * 1000;

      const registeredAt = Number(birthday.registeredAt);
      const now = Date.now();

      if (
        !Number.isSafeInteger(registeredAt) ||
        registeredAt <= 0 ||
        registeredAt > now
      ) {
        return respond(
          '♡ your birthday needs to be registered under ' +
          'the new reward system before you can claim!\n\n' +
          '🎀 use `/birthday set` to confirm your birthday. ' +
          'your 30-day eligibility period will begin then.'
        );
      }

      const eligibleAt = registeredAt + WAITING_PERIOD;

      if (now < eligibleAt) {
        const daysRemaining = Math.ceil(
          (eligibleAt - now) / (24 * 60 * 60 * 1000)
        );

        return respond(
          '♡ your birthday reward is not eligible yet!\n\n' +
          `🎀 **waiting period:** ${daysRemaining} day(s) remaining\n` +
          '♡ birthday rewards require 30 days of registration.'
        );
      }

      if (
        registered.month !== today.month ||
        registered.day !== today.day
      ) {
        return respond(
          '♡ today is not your registered birthday!\n\n' +
          `🎀 **your birthday:** ${MONTHS[registered.month - 1]} ${registered.day}`
        );
      }

      const pool = getPaymentPool();
      const db = await pool.connect();
      let transaction = false;

      try {
        const version = await db.query(
          'SELECT MAX(version) AS version FROM schema_migrations'
        );

        if (Number(version.rows[0]?.version) !== 2) {
          throw new Error('Economy schema v2 required.');
        }

        await db.query('BEGIN');
        transaction = true;

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

        const row = account.rows[0];
        if (!row) throw new Error('Birthday account unavailable.');

        const data = row.data ?? {};
        const wallet = Number(row.balance);
        const savedWallet = Number(data.wallet ?? row.balance);

        if (
          !Number.isSafeInteger(wallet) ||
          wallet < 0 ||
          !Number.isSafeInteger(savedWallet) ||
          savedWallet !== wallet
        ) {
          throw new Error('Wallet consistency error.');
        }

        const prior = data.birthdayReward ?? {};
        const lastYear = Number(prior.lastClaimYear ?? 0);
        const originalMonth = Number(prior.month ?? registered.month);
        const originalDay = Number(prior.day ?? registered.day);

        if (
          !Number.isSafeInteger(lastYear) ||
          lastYear < 0 ||
          !Number.isInteger(originalMonth) ||
          !Number.isInteger(originalDay)
        ) {
          throw new Error('Invalid birthday reward history.');
        }

        if (
          originalMonth !== registered.month ||
          originalDay !== registered.day
        ) {
          await db.query('ROLLBACK');
          transaction = false;

          return respond(
            '♡ your registered birthday differs from your ' +
            'previous reward record. please contact staff!'
          );
        }

        if (lastYear >= today.year) {
          await db.query('ROLLBACK');
          transaction = false;

          return respond(
            '♡ you already claimed your birthday reward this year!'
          );
        }

        const newWallet = wallet + REWARD;

        if (!Number.isSafeInteger(newWallet)) {
          throw new Error('Wallet exceeds safe integer limits.');
        }

        const newData = {
          ...data,
          wallet: newWallet,
          birthdayReward: {
            month: registered.month,
            day: registered.day,
            lastClaimYear: today.year,
          },
        };

        await db.query(
          `UPDATE economy
           SET balance = $3,
               data = $4::jsonb,
               updated_at = CURRENT_TIMESTAMP
           WHERE guild_id = $1 AND user_id = $2`,
          [
            guildId,
            userId,
            newWallet,
            JSON.stringify(newData),
          ]
        );

        await db.query(
          `INSERT INTO cunvrs_economy_ledger
             (
               operation_id, guild_id, user_id,
               actor_id, event_type, amount,
               balance_before, balance_after, details
             )
           VALUES (
             $1, $2, $3, $3, 'birthday_reward',
             $4, $5, $6, $7::jsonb
           )`,
          [
            claimOperationId(guildId, userId, today.year),
            guildId,
            userId,
            REWARD,
            wallet,
            newWallet,
            JSON.stringify({
              year: today.year,
              month: registered.month,
              day: registered.day,
            }),
          ]
        );

        await db.query('COMMIT');
        transaction = false;

        return respond(
          `🎀 **happy birthday, <@${userId}>!**\n\n` +
          `${UNICOIN_EMOJI} **earned:** +${REWARD.toLocaleString()}\n` +
          `${UNICOIN_EMOJI} **wallet:** ${newWallet.toLocaleString()}\n\n` +
          '♡ enjoy your special day!'
        );
      } catch (error) {
        if (transaction) {
          await db.query('ROLLBACK').catch(() => {});
        }
        throw error;
      } finally {
        db.release();
      }
    } catch (error) {
      console.error('[CUNVRS BIRTHDAY CLAIM]', error);

      return respond(
        '♡ your birthday reward could not be confirmed. ' +
        'please check your balance before trying again.'
      );
    }
  },
};
