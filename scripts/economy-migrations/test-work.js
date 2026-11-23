
import pg from 'pg';
import { randomInt } from 'node:crypto';
import { awardWorkShift } from '../../src/commands/Economy/modules/workRewards.js';
import { getCareer } from '../../src/commands/Economy/modules/careers.js';

const password = process.env.CUNVRS_LOCAL_DB_PASSWORD;

if (!password) {
  throw new Error('Missing local PostgreSQL password.');
}

const pool = new pg.Pool({
  host: '127.0.0.1',
  port: 5432,
  database: 'cunvrs_restore_test',
  user: 'postgres',
  password,
  ssl: false,
  max: 3,
  connectionTimeoutMillis: 5000,
});

const guildId = '1253406230999863316';
const suffix = randomInt(100000000, 999999999);
const userId = `1777777777${suffix}`;
const interactionId = `1777777778${suffix}`;
const retryInteractionId = `1777777779${suffix}`;
const job = getCareer('flower');

async function main() {
  const target = await pool.query(
    'SELECT current_database() AS db, inet_server_addr()::text AS addr'
  );

  const { db, addr } = target.rows[0];

  if (
    db !== 'cunvrs_restore_test' ||
    !['127.0.0.1', '127.0.0.1/32'].includes(addr)
  ) {
    throw new Error('Wrong database. Test cancelled.');
  }

  const version = await pool.query(
    'SELECT MAX(version) AS version FROM schema_migrations'
  );

  if (Number(version.rows[0].version) !== 2) {
    throw new Error('Local database must be schema v2.');
  }

  // Create an isolated test account with a Flower Picker job.
  await pool.query(
    'INSERT INTO guilds (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
    [guildId]
  );

  await pool.query(
    `INSERT INTO users (id)
     VALUES ($1)
     ON CONFLICT (id) DO NOTHING`,
    [userId]
  );

  await pool.query(
    `INSERT INTO economy
       (guild_id, user_id, balance, bank, data)
     VALUES
       ($1, $2, 0, 0,
        '{"wallet":0,"bank":0,"level":1,"careerJob":"flower"}'::jsonb)`,
    [guildId, userId]
  );

  console.log('Testing Flower Picker shift...');

  const result = await awardWorkShift(pool, {
    guildId,
    userId,
    interactionId,
    job,
    mode: 'quick',
    basePay: 200,
    careerXp: 10,
  });

  if (result.earned !== 140) {
    throw new Error(`Expected 140 Unicoins, got ${result.earned}`);
  }

  console.log(`Work reward: ${result.earned} Unicoins`);
  console.log(`Career XP awarded: ${result.careerXp}`);
  console.log(`Shifts today: ${result.shiftsToday}`);

  // A second immediate shift must be rejected.
  let cooldownBlocked = false;

  try {
    await awardWorkShift(pool, {
      guildId,
      userId,
      interactionId: retryInteractionId,
      job,
      mode: 'quick',
      basePay: 200,
      careerXp: 10,
    });
  } catch (error) {
    cooldownBlocked = error.message.includes('cooldown');
  }

  if (!cooldownBlocked) {
    throw new Error('Work cooldown was not enforced!');
  }

  const wallet = await pool.query(
    `SELECT balance, data
     FROM economy
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );

  const ledger = await pool.query(
    `SELECT COUNT(*)::integer AS count
     FROM cunvrs_economy_ledger
     WHERE guild_id = $1 AND user_id = $2
       AND event_type = 'work_reward'`,
    [guildId, userId]
  );

  if (
    Number(wallet.rows[0].balance) !== 140 ||
    wallet.rows[0].data.wallet !== 140 ||
    wallet.rows[0].data.careerXp !== 10 ||
    Number(ledger.rows[0].count) !== 1
  ) {
    throw new Error('Work reward data did not save correctly.');
  }

  console.log('Work cooldown enforced: YES');
  console.log('Wallet and career XP saved: YES');
  console.log('Transaction ledger recorded: YES');
  console.log('ALL WORK REWARD TESTS PASSED!');
}

try {
  await main();
} catch (error) {
  console.error('WORK TEST FAILED:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
