
import { createHash, randomInt } from 'node:crypto';
import { addLevelXp } from '../../../utils/progression.js';

const DAILY_MINIGAME_CAP = 1500;
const DAILY_REPEATABLE_CAP = 5000;

function detroitDay() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Detroit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const part = name =>
    parts.find(item => item.type === name)?.value;

  return `${part('year')}-${part('month')}-${part('day')}`;
}

function operationId(interactionId) {
  const h = createHash('sha256')
    .update(`cunvrs:minigame:guessnumber:${interactionId}`)
    .digest('hex');

  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `4${h.slice(13, 16)}`,
    `8${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join('-');
}

export async function playGuessNumber(
  pool,
  { guildId, userId, interactionId, guess }
) {
  if (
    !/^\d{15,22}$/.test(guildId || '') ||
    !/^\d{15,22}$/.test(userId || '') ||
    !/^\d{15,22}$/.test(interactionId || '') ||
    !Number.isInteger(guess) ||
    guess < 1 ||
    guess > 10
  ) {
    throw new Error('Invalid guess-number request.');
  }

  const db = await pool.connect();
  let transaction = false;

  try {
    const schema = await db.query(
      'SELECT MAX(version) AS version FROM schema_migrations'
    );

    if (Number(schema.rows[0]?.version) !== 2) {
      throw new Error('Economy database v2 is required.');
    }

    await db.query('BEGIN');
    transaction = true;

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
         '{"wallet":0,"bank":0,"level":1,"xp":0}'::jsonb
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

    if (!row) {
      throw new Error('Minigame account unavailable.');
    }

    const data = row.data || {};
    const wallet = Number(row.balance);
    const savedWallet = Number(data.wallet ?? row.balance);

    if (
      !Number.isSafeInteger(wallet) ||
      wallet < 0 ||
      wallet !== savedWallet
    ) {
      throw new Error('Wallet consistency error.');
    }

    const now = Date.now();
    const cooldowns = data.minigameCooldowns || {};
    const lastPlayed = Number(cooldowns.guessnumber ?? 0);
    const nextPlay = lastPlayed + 5 * 60_000;

    if (!Number.isSafeInteger(lastPlayed) || lastPlayed < 0) {
      throw new Error('Invalid minigame cooldown.');
    }

    if (lastPlayed > 0 && now < nextPlay) {
      await db.query('ROLLBACK');
      transaction = false;
      return { cooldown: true, nextPlay };
    }

    const day = detroitDay();

    await db.query(
      `INSERT INTO cunvrs_economy_daily_limits
         (guild_id, user_id, local_day)
       VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, user_id, local_day)
       DO NOTHING`,
      [guildId, userId, day]
    );

    const daily = await db.query(
      `SELECT repeatable_coins, minigame_coins
       FROM cunvrs_economy_daily_limits
       WHERE guild_id = $1
         AND user_id = $2
         AND local_day = $3
       FOR UPDATE`,
      [guildId, userId, day]
    );

    const limits = daily.rows[0];

    if (!limits) {
      throw new Error('Daily limits unavailable.');
    }

    const repeatable = Number(limits.repeatable_coins);
    const minigames = Number(limits.minigame_coins);

    if (
      !Number.isSafeInteger(repeatable) ||
      !Number.isSafeInteger(minigames) ||
      repeatable < 0 ||
      repeatable > DAILY_REPEATABLE_CAP ||
      minigames < 0 ||
      minigames > DAILY_MINIGAME_CAP ||
      minigames > repeatable
    ) {
      throw new Error('Invalid daily earning totals.');
    }

    const winningNumber = randomInt(1, 11);
    const won = guess === winningNumber;

    const earned = won
      ? Math.min(
          50,
          DAILY_MINIGAME_CAP - minigames,
          DAILY_REPEATABLE_CAP - repeatable
        )
      : 0;

    const xpEarned = won && earned > 0 ? 10 : 0;

    const progress = addLevelXp(
      Number(data.level ?? 1),
      Number(data.xp ?? 0),
      xpEarned
    );

    const newWallet = wallet + earned;

    if (!Number.isSafeInteger(newWallet)) {
      throw new Error('Invalid resulting wallet.');
    }

    const updatedData = {
      ...data,
      wallet: newWallet,
      level: progress.level,
      xp: progress.xp,
      minigameCooldowns: {
        ...cooldowns,
        guessnumber: now,
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
        JSON.stringify(updatedData),
      ]
    );

    if (earned > 0) {
      await db.query(
        `UPDATE cunvrs_economy_daily_limits
         SET repeatable_coins = repeatable_coins + $4,
             minigame_coins = minigame_coins + $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE guild_id = $1 AND user_id = $2
           AND local_day = $3`,
        [guildId, userId, day, earned]
      );

      await db.query(
        `INSERT INTO cunvrs_economy_ledger
           (operation_id, guild_id, user_id, actor_id,
            event_type, amount, balance_before,
            balance_after, details)
         VALUES
           ($1, $2, $3, $3, 'minigame_guessnumber',
            $4, $5, $6, $7::jsonb)`,
        [
          operationId(interactionId),
          guildId,
          userId,
          earned,
          wallet,
          newWallet,
          JSON.stringify({ guess, winningNumber }),
        ]
      );
    }

    await db.query('COMMIT');
    transaction = false;

    return {
      cooldown: false,
      guess,
      winningNumber,
      won,
      earned,
      xpEarned,
      wallet: newWallet,
      level: progress.level,
      xp: progress.xp,
      xpToNextLevel: progress.xpToNextLevel,
      nextPlay: now + 5 * 60_000,
      dailyMinigameCoins: minigames + earned,
      dailyRepeatableCoins: repeatable + earned,
    };
  } catch (error) {
    if (transaction) {
      await db.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    db.release();
  }
}
