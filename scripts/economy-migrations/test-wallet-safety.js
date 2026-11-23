
import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import pg from 'pg';
import { changeUnicoins } from '../../src/utils/wallet.js';

const password = process.env.CUNVRS_LOCAL_DB_PASSWORD;

if (!password) {
  throw new Error('Local PostgreSQL password required.');
}

const pool = new pg.Pool({
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  password,
  database: 'cunvrs_restore_test',
  ssl: false,
  max: 5,
});

async function main() {
  // Read-only safety verification before test writes.
  const check = await pool.query(`
    SELECT
      current_database() AS db,
      inet_server_addr()::text AS address,
      (SELECT MAX(version) FROM schema_migrations) AS version
  `);

  const info = check.rows[0];

  assert.equal(info.db, 'cunvrs_restore_test');
  assert.ok(
    ['127.0.0.1', '127.0.0.1/32'].includes(info.address),
    'SAFETY STOP: database must be local.'
  );
  assert.equal(Number(info.version), 2);

  console.log('PASS: Approved local v2 database.');

  const guildId =
    `1888888888${randomInt(100000000, 999999999)}`;

  const userId =
    `1777777777${randomInt(100000000, 999999999)}`;

  const actorId =
    `1666666666${randomInt(100000000, 999999999)}`;

  console.log('\n=== WALLET CONSISTENCY TEST ===');

  await changeUnicoins(pool, {
    guildId,
    userId,
    actorId,
    amount: 100,
    eventType: 'admin_credit',
    operationId: randomUUID(),
  });

  // Deliberately corrupt ONLY our temporary test account.
  await pool.query(
    `UPDATE economy
     SET data = jsonb_set(
       data, '{wallet}', to_jsonb(999::bigint), true
     )
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );

  await assert.rejects(
    changeUnicoins(pool, {
      guildId,
      userId,
      actorId,
      amount: 50,
      eventType: 'admin_credit',
      operationId: randomUUID(),
    }),
    /Wallet consistency error/
  );

  console.log('PASS: Mismatched wallet rejected.');

  // Repair the temporary test account.
  await pool.query(
    `UPDATE economy
     SET data = jsonb_set(
       data, '{wallet}', to_jsonb(100::bigint), true
     )
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );

  console.log('PASS: Test account restored.');

  console.log('\n=== SIMULTANEOUS SPENDING TEST ===');

  // Ten attempts to spend 15 from a wallet holding 100.
  // Only six transactions should succeed.
  const attempts = Array.from({ length: 10 }, () =>
    changeUnicoins(pool, {
      guildId,
      userId,
      actorId,
      amount: -15,
      eventType: 'admin_debit',
      operationId: randomUUID(),
    })
  );

  const results = await Promise.allSettled(attempts);

  const successful = results.filter(
    result => result.status === 'fulfilled'
  );

  const rejected = results.filter(
    result => result.status === 'rejected'
  );

  assert.equal(successful.length, 6);
  assert.equal(rejected.length, 4);

  const finalAccount = await pool.query(
    `SELECT balance, data
     FROM economy
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );

  assert.equal(Number(finalAccount.rows[0].balance), 10);
  assert.equal(Number(finalAccount.rows[0].data.wallet), 10);

  const ledger = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM cunvrs_economy_ledger
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );

  // One initial credit plus six successful debits.
  assert.equal(ledger.rows[0].total, 7);

  console.log('PASS: 6 spending attempts succeeded.');
  console.log('PASS: 4 insufficient-funds attempts rejected.');
  console.log('PASS: Final wallet contains 10 Unicoins.');
  console.log('PASS: Ledger contains exactly 7 transactions.');

  console.log('\nALL WALLET SAFETY TESTS PASSED!');
}

try {
  await main();
} catch (error) {
  console.error('\nTEST FAILED:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
