
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';

const password = process.env.CUNVRS_LOCAL_DB_PASSWORD;

if (!password) {
  throw new Error(
    'CUNVRS_LOCAL_DB_PASSWORD is required.'
  );
}

// Force this test process to target local PostgreSQL.
const localUrl =
  `postgresql://postgres:${encodeURIComponent(password)}` +
  '@127.0.0.1:5432/cunvrs_restore_test';

Object.assign(process.env, {
  POSTGRES_URL: localUrl,
  DATABASE_URL: localUrl,
  POSTGRES_HOST: '127.0.0.1',
  POSTGRES_PORT: '5432',
  POSTGRES_USER: 'postgres',
  POSTGRES_PASSWORD: password,
  POSTGRES_DB: 'cunvrs_restore_test',
  POSTGRES_DATABASE: 'cunvrs_restore_test',
  PGHOST: '127.0.0.1',
  PGPORT: '5432',
  PGUSER: 'postgres',
  PGPASSWORD: password,
  PGDATABASE: 'cunvrs_restore_test',
  POSTGRES_SSL: 'false',
  PGSSLMODE: 'disable',
});

const { getPaymentPool } = await import(
  '../../src/commands/Economy/modules/paymentHandler.js'
);

const daily = (
  await import('../../src/commands/Economy/daily.js')
).default;

const study = (
  await import('../../src/commands/Economy/study.js')
).default;

const pool = getPaymentPool();

function makeInteraction(command, guildId, userId) {
  const replies = [];

  return {
    id: `${Date.now()}${randomInt(100000, 999999)}`,
    guildId,
    user: { id: userId },
    deferred: false,
    replied: false,
    replies,

    async deferReply() {
      this.deferred = true;
    },

    async editReply(payload) {
      replies.push(payload);
      return payload;
    },
  };
}

async function getAccount(guildId, userId) {
  const result = await pool.query(
    `SELECT balance, data
     FROM economy
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );

  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function main() {
  // Before ANY test writes, verify the actual server.
  const server = await pool.query(`
    SELECT
      current_database() AS database_name,
      inet_server_addr()::text AS server_address,
      (SELECT MAX(version) FROM schema_migrations)
        AS schema_version
  `);

  const info = server.rows[0];

  console.log('\n=== DATABASE SAFETY DIAGNOSTICS ===');
console.log('Database:', info.database_name);
console.log('Server address:', info.server_address);
console.log('Schema version:', info.schema_version);
console.log('===================================\n');

  if (
    info.database_name !== 'cunvrs_restore_test' ||
    !['127.0.0.1', '127.0.0.1/32', '::1', '::1/128'].includes(info.server_address) ||
    Number(info.schema_version) !== 2
  ) {
    throw new Error(
      'SAFETY STOP: connection is not the approved local v2 database.'
    );
  }

  console.log('PASS: Connected to local test database only.');

  const guildId =
    `1888888888${randomInt(100000000, 999999999)}`;

  const userId =
    `1777777777${randomInt(100000000, 999999999)}`;

  console.log('\n=== DAILY TESTS ===');

  const firstDaily = makeInteraction(
    'daily',
    guildId,
    userId
  );

  await daily.execute(firstDaily);

  const afterDaily = await getAccount(guildId, userId);

  assert.equal(Number(afterDaily.balance), 400);
  assert.equal(Number(afterDaily.data.wallet), 400);
  assert.equal(Number(afterDaily.data.dailyStreak), 1);

  console.log('PASS: First daily awarded 400 Unicoins.');

  const secondDaily = makeInteraction(
    'daily',
    guildId,
    userId
  );

  await daily.execute(secondDaily);

  const afterRetry = await getAccount(guildId, userId);

  assert.equal(Number(afterRetry.balance), 400);
  assert.equal(Number(afterRetry.data.dailyStreak), 1);

  console.log('PASS: Daily cooldown blocked another reward.');

  const ledger = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM cunvrs_economy_ledger
     WHERE guild_id = $1
       AND user_id = $2
       AND event_type = 'daily_reward'`,
    [guildId, userId]
  );

  assert.equal(ledger.rows[0].total, 1);

  console.log('PASS: Exactly one daily ledger entry.');

  console.log('\n=== STUDY TESTS ===');

  const firstStudy = makeInteraction(
    'study',
    guildId,
    userId
  );

  await study.execute(firstStudy);

  const afterStudy = await getAccount(guildId, userId);

  const gainedIq = Number(afterStudy.data.iq);

  assert.ok(
    gainedIq >= 3 && gainedIq <= 5,
    'IQ gain must be between 3 and 5.'
  );

  assert.equal(Number(afterStudy.data.level), 1);
  assert.equal(Number(afterStudy.data.xp), 25);
  assert.equal(Number(afterStudy.balance), 400);
  assert.equal(Number(afterStudy.data.wallet), 400);

  console.log(`PASS: Studying awarded ${gainedIq} IQ and 25 XP.`);
  console.log('PASS: Wallet remained unchanged.');

  const secondStudy = makeInteraction(
    'study',
    guildId,
    userId
  );

  await study.execute(secondStudy);

  const afterStudyRetry = await getAccount(
    guildId,
    userId
  );

  assert.equal(
    Number(afterStudyRetry.data.iq),
    gainedIq
  );

  assert.equal(
    Number(afterStudyRetry.data.xp),
    25
  );

  console.log('PASS: Study cooldown blocked another reward.');

  console.log('\nALL REWARD INTEGRATION TESTS PASSED!');
}

try {
  await main();
} catch (error) {
  console.error('\nTEST FAILED:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
