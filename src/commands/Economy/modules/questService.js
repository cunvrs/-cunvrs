
import { createHash } from 'node:crypto';
import { getPaymentPool } from './paymentHandler.js';

export const QUESTS = Object.freeze({
  work: {
    name: '💼 Hard Worker',
    description: 'Complete 2 work shifts.',
    goal: 2,
    reward: 150,
  },
  games: {
    name: '🎮 Game Champion',
    description: 'Win 3 minigames.',
    goal: 3,
    reward: 200,
  },
  coins: {
    name: '🌸 Unicoin Collector',
    description: 'Earn 500 Unicoins from repeatable activities.',
    goal: 500,
    reward: 250,
  },
});

function requireId(id) {
  if (typeof id !== 'string' || !/^\d{15,22}$/.test(id)) {
    throw new Error('Invalid Discord ID.');
  }
}

function operationId(guildId, userId, day, questId) {
  const hash = createHash('sha256')
    .update(`cunvrs:quest:${guildId}:${userId}:${day}:${questId}`)
    .digest('hex');

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

function safeNumber(value) {
  const num = Number(value ?? 0);

  if (!Number.isSafeInteger(num) || num < 0) {
    throw new Error('Invalid economy counter.');
  }

  return num;
}

async function currentDay(db) {
  const result = await db.query(
    `SELECT
       (CURRENT_TIMESTAMP AT TIME ZONE 'America/Detroit')
       ::date::text AS day`
  );

  return result.rows[0].day;
}

async function loadProgress(db, guildId, userId, day) {
  const daily = await db.query(
    `SELECT work_shifts, repeatable_coins
     FROM cunvrs_economy_daily_limits
     WHERE guild_id = $1
       AND user_id = $2
       AND local_day = $3::date`,
    [guildId, userId, day]
  );

  const games = await db.query(
    `SELECT COUNT(*)::int AS wins
     FROM cunvrs_economy_ledger
     WHERE guild_id = $1
       AND user_id = $2
       AND event_type LIKE 'minigame_%'
       AND amount > 0
       AND (created_at AT TIME ZONE 'America/Detroit')
           ::date = $3::date`,
    [guildId, userId, day]
  );

  return {
    work: safeNumber(daily.rows[0]?.work_shifts),
    games: safeNumber(games.rows[0]?.wins),
    coins: safeNumber(daily.rows[0]?.repeatable_coins),
  };
}

async function loadClaims(db, guildId, userId, day) {
  const result = await db.query(
    `SELECT details->>'questId' AS quest_id
     FROM cunvrs_economy_ledger
     WHERE guild_id = $1
       AND user_id = $2
       AND event_type = 'quest_reward'
       AND details->>'day' = $3`,
    [guildId, userId, day]
  );

  return new Set(
    result.rows.map(row => row.quest_id).filter(Boolean)
  );
}

export async function getQuestStatus(guildId, userId) {
  requireId(guildId);
  requireId(userId);

  const pool = getPaymentPool();
  const day = await currentDay(pool);

  const progress = await loadProgress(
    pool, guildId, userId, day
  );

  const claimed = await loadClaims(
    pool, guildId, userId, day
  );

  return {
    day,
    quests: Object.entries(QUESTS).map(([id, quest]) => ({
      id,
      ...quest,
      progress: Math.min(progress[id], quest.goal),
      completed: progress[id] >= quest.goal,
      claimed: claimed.has(id),
    })),
  };
}

export async function claimQuest(guildId, userId, questId) {
  requireId(guildId);
  requireId(userId);

  const quest = QUESTS[questId];

  if (!quest) {
    return {
      success: false,
      message: 'That quest does not exist.',
    };
  }

  const pool = getPaymentPool();
  const db = await pool.connect();
  let transaction = false;

  try {
    // Verify that this is the new economy schema.
    const version = await db.query(
      'SELECT MAX(version) AS version FROM schema_migrations'
    );

    if (Number(version.rows[0]?.version) !== 2) {
      throw new Error('Economy schema v2 is required.');
    }

    await db.query('BEGIN');
    transaction = true;

    const day = await currentDay(db);

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

    // Serialize claims and wallet changes for this user.
    const account = await db.query(
      `SELECT balance, data
       FROM economy
       WHERE guild_id = $1 AND user_id = $2
       FOR UPDATE`,
      [guildId, userId]
    );

    const row = account.rows[0];

    if (!row) {
      throw new Error('Economy account is unavailable.');
    }

    const data = row.data ?? {};
    const wallet = safeNumber(row.balance);
    const storedWallet = safeNumber(
      data.wallet ?? row.balance
    );

    if (wallet !== storedWallet) {
      throw new Error('Wallet consistency error.');
    }

    const op = operationId(
      guildId, userId, day, questId
    );

    const previous = await db.query(
      `SELECT 1
       FROM cunvrs_economy_ledger
       WHERE operation_id = $1`,
      [op]
    );

    if (previous.rows.length > 0) {
      await db.query('ROLLBACK');
      transaction = false;

      return {
        success: false,
        message: 'You already claimed this quest today!',
      };
    }

    const progress = await loadProgress(
      db, guildId, userId, day
    );

    if (progress[questId] < quest.goal) {
      await db.query('ROLLBACK');
      transaction = false;

      return {
        success: false,
        message:
          `Quest incomplete! Progress: ` +
          `${progress[questId]}/${quest.goal}.`,
      };
    }

    const newWallet = wallet + quest.reward;

    if (!Number.isSafeInteger(newWallet)) {
      throw new Error('Wallet balance exceeds safe limits.');
    }

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
        JSON.stringify({
          ...data,
          wallet: newWallet,
        }),
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
         $1, $2, $3, $3, 'quest_reward',
         $4, $5, $6, $7::jsonb
       )`,
      [
        op,
        guildId,
        userId,
        quest.reward,
        wallet,
        newWallet,
        JSON.stringify({
          questId,
          day,
        }),
      ]
    );

    await db.query('COMMIT');
    transaction = false;

    return {
      success: true,
      quest: quest.name,
      earned: quest.reward,
      wallet: newWallet,
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
