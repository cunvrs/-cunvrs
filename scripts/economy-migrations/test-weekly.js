
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';

const password = process.env.CUNVRS_LOCAL_DB_PASSWORD;

if (!password) {
  throw new Error('Local PostgreSQL password required.');
}

const url =
  `postgresql://postgres:${encodeURIComponent(password)}` +
  '@127.0.0.1:5432/cunvrs_restore_test';

Object.assign(process.env, {
  POSTGRES_URL: url,
  DATABASE_URL: url,
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

const weekly = (
  await import('../../src/commands/Economy/weekly.js')
).default;

const pool = getPaymentPool();

function interaction(guildId, userId) {
  return {
    id: `1777777777${randomInt(100000000, 999999999)}`,
    guildId,
    user: { id: userId },
    replies: [],

    async deferReply() {},

    async editReply(payload) {
      this.replies.push(payload);
      return payload;
    },
  };
}

async function main() {
  const { rows } = await pool.query(`
    SELECT
      current_database() AS db,
      inet_server_addr()::text AS address,
      (SELECT MAX(version) FROM schema_migrations) AS version
  `);

  const info = rows[0];

  if (
    info.db !== 'cunvrs_restore_test' ||
    !['127.0.0.1', '127.0.0.1/32'].includes(info.address) ||
    Number(info.version) !== 2
  ) {
    throw new Error('SAFETY STOP: Not the approved local v2 database.');
  }

  console.log('PASS: Approved local test database.');

  const guildId = `1888888888${randomInt(100000000, 999999999)}`;
  const userId = `1777777777${randomInt(100000000, 999999999)}`;

  console.log('\n=== WEEKLY REWARD TEST ===');

  const first = interaction(guildId, userId);
  await weekly.execute(first);

  const account = await pool.query(
    `SELECT balance, data FROM economy
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );

  assert.equal(account.rows.length, 1);

  const row = account.rows[0];

  assert.equal(Number(row.balance), 2000);
  assert.equal(Number(row.data.wallet), 2000);
  assert.ok(Number(row.data.lastWeekly) > 0);

  console.log('PASS: First weekly awarded 2,000 Unicoins.');

  const second = interaction(guildId, userId);
  await weekly.execute(second);

  assert.ok(
    JSON.stringify(second.replies).includes('already claimed'),
    'Expected weekly cooldown response.'
  );

  const afterRetry = await pool.query(
    `SELECT balance FROM economy
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );

  assert.equal(Number(afterRetry.rows[0].balance), 2000);

  console.log('PASS: Weekly cooldown prevented another reward.');

  const ledger = await pool.query(
    `SELECT amount, balance_before, balance_after
     FROM cunvrs_economy_ledger
     WHERE guild_id = $1 AND user_id = $2
       AND event_type = 'weekly_reward'`,
    [guildId, userId]
  );

  assert.equal(ledger.rows.length, 1);
  assert.equal(Number(ledger.rows[0].amount), 2000);
  assert.equal(Number(ledger.rows[0].balance_before), 0);
  assert.equal(Number(ledger.rows[0].balance_after), 2000);

  console.log('PASS: Exactly one correct ledger entry.');
  console.log('PASS: Wallet and database balance match.');

  console.log('\nALL WEEKLY REWARD TESTS PASSED!');
}

try {
  await main();
} catch (error) {
  console.error('TEST FAILED:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
