
import { createHash } from 'node:crypto';
import { careerRank } from './careers.js';

const DAILY_COIN_LIMIT = 5000;
const DAILY_SHIFT_LIMIT = 10;
const WORK_COOLDOWN = 30 * 60 * 1000;

function detroitDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Detroit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const get = (type) =>
    parts.find((part) => part.type === type).value;

  return `${get('year')}-${get('month')}-${get('day')}`;
}

function iqBonus(data) {
  const iq = Math.max(0, Math.min(250, Number(data.iq) || 0));

  // +1% for every 10 IQ, up to +9% before college.
  if (!data.collegeGraduated) {
    return Math.min(0.09, Math.floor(iq / 10) * 0.01);
  }

  // College graduates receive +15% at IQ 100,
  // increasing to +30% at IQ 250.
  return 0.15 +
    Math.max(0, Math.floor((iq - 100) / 10)) * 0.01;
}

export async function awardWorkShift(pool, options) {
  const {
    guildId,
    userId,
    interactionId,
    job,
    mode,
    correct = null,
    basePay,
    careerXp,
  } = options;

  if (!/^\d{15,22}$/.test(guildId) ||
      !/^\d{15,22}$/.test(userId) ||
      !/^\d{15,22}$/.test(interactionId)) {
    throw new Error('Invalid Discord account.');
  }

  if (!job || !Number.isSafeInteger(basePay) ||
      basePay < job.minPay || basePay > job.maxPay) {
    throw new Error('Invalid work reward.');
  }

  if (!['quick', 'interactive'].includes(mode)) {
    throw new Error('Invalid work mode.');
  }

  if (mode === 'interactive' && typeof correct !== 'boolean') {
    throw new Error('Interactive shift result is missing.');
  }
  // CUNVRS_WORK_IDEMPOTENCY_V1
  const hash = createHash('sha256')
    .update('cunvrs:work:' + interactionId)
    .digest('hex');

  const operationId = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    '8' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');


  const db = await pool.connect();

  try {
    await db.query('BEGIN');

    // CUNVRS_WORK_SCHEMA_GUARD_V1
    // Fail closed before changing any wallet or daily-limit rows.
    const schemaVersion = await db.query(
      'SELECT MAX(version) AS version FROM schema_migrations'
    );

    if (Number(schemaVersion.rows[0]?.version) !== 2) {
      throw new Error('Work rewards require economy schema v2.');
    }

    // Ensure the member exists before locking their wallet.
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
       VALUES ($1, $2, 0, 0, '{"wallet":0,"bank":0,"level":1}'::jsonb)
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
      throw new Error('Work account unavailable.');
    }

    const data = row.data || {};

    const priorShift = await db.query(
      `SELECT operation_id
       FROM cunvrs_economy_ledger
       WHERE operation_id = $1`,
      [operationId]
    );

    if (priorShift.rows.length) {
      throw new Error('Work shift already processed.');
    }

    if (data.careerJob !== job.id) {
      throw new Error('Your career changed. Start a new shift.');
    }

    const now = Date.now();
    const lastWork = Number(data.lastWork || 0);

    if (now < lastWork + WORK_COOLDOWN) {
      throw new Error('Your work cooldown is still active.');
    }

    const today = detroitDate();

    await db.query(
      `INSERT INTO cunvrs_economy_daily_limits
         (guild_id, user_id, local_day)
       VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, user_id, local_day) DO NOTHING`,
      [guildId, userId, today]
    );

    const limits = await db.query(
      `SELECT repeatable_coins, work_shifts
       FROM cunvrs_economy_daily_limits
       WHERE guild_id = $1 AND user_id = $2
         AND local_day = $3
       FOR UPDATE`,
      [guildId, userId, today]
    );

    const daily = limits.rows[0];

    const shifts = Number(daily.work_shifts);
    const earnedToday = Number(daily.repeatable_coins);

    if (shifts >= DAILY_SHIFT_LIMIT) {
      throw new Error('You have completed all 10 shifts today!');
    }

    const rank = careerRank(Number(data.careerShifts || 0));

    const modeMultiplier =
      mode === 'quick' ? 0.7 : correct ? 1 : 0.5;

    const bonus = rank.bonus + iqBonus(data);

    const calculated = Math.floor(
      basePay * modeMultiplier * (1 + bonus)
    );

    const remaining = DAILY_COIN_LIMIT - earnedToday;
    const earned = Math.max(0, Math.min(calculated, remaining));

    const before = Number(row.balance);
    const storedWallet = Number(data.wallet ?? row.balance);

    if (
      !Number.isSafeInteger(before) ||
      before < 0 ||
      !Number.isSafeInteger(storedWallet) ||
      storedWallet !== before
    ) {
      throw new Error('Wallet consistency error.');
    }

    if (
      !Number.isSafeInteger(earnedToday) ||
      earnedToday < 0 ||
      earnedToday > DAILY_COIN_LIMIT
    ) {
      throw new Error('Invalid daily earning total.');
    }

    const after = before + earned;

    if (!Number.isSafeInteger(after)) {
      throw new Error('Wallet balance exceeds supported limits.');
    }

    const updatedData = {
      ...data,
      wallet: after,
      lastWork: now,
      careerXp: Number(data.careerXp || 0) + careerXp,
      careerShifts: Number(data.careerShifts || 0) + 1,
      workDay: today,
      workDayCount: shifts + 1,
      workPendingUntil: 0,
    };

    await db.query(
      `UPDATE economy
       SET balance = $3, data = $4::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId, after, JSON.stringify(updatedData)]
    );

    await db.query(
      `UPDATE cunvrs_economy_daily_limits
       SET repeatable_coins = repeatable_coins + $4,
           work_shifts = work_shifts + 1,
           updated_at = NOW()
       WHERE guild_id = $1 AND user_id = $2
         AND local_day = $3`,
      [guildId, userId, today, earned]
    );

    {
      await db.query(
        `INSERT INTO cunvrs_economy_ledger
           (operation_id, guild_id, user_id, actor_id,
            event_type, amount, balance_before,
            balance_after, details)
         VALUES ($1, $2, $3, $3, 'work_reward',
                 $4, $5, $6, $7::jsonb)`,
        [
          operationId,
          guildId,
          userId,
          earned,
          before,
          after,
          JSON.stringify({
            job: job.id,
            mode,
            correct,
            careerXp,
          }),
        ]
      );
    }

    await db.query('COMMIT');

    return {
      earned,
      wallet: after,
      careerXp,
      rank: rank.name,
      dailyEarned: earnedToday + earned,
      shiftsToday: shifts + 1,
      nextWork: now + WORK_COOLDOWN,
      dailyCapReached: earnedToday + earned >= DAILY_COIN_LIMIT,
    };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}
