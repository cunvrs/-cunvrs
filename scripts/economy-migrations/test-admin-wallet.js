
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import pg from 'pg';

const password = process.env.CUNVRS_LOCAL_DB_PASSWORD;
if (!password) {
  throw new Error('Local PostgreSQL password required.');
}

const pool = new pg.Pool({
  host: '127.0.0.1',
  port: 5432,
  database: 'cunvrs_restore_test',
  user: 'postgres',
  password,
  ssl: false,
  max: 3,
});

async function main() {
  // Verify the database BEFORE any writes.
  const { rows } = await pool.query(`
    SELECT
      current_database() AS db,
      inet_server_addr()::text AS address,
      (SELECT MAX(version) FROM schema_migrations) AS version
  `);

  const info = rows[0];

  assert.equal(info.db, 'cunvrs_restore_test');
  assert.ok(
    ['127.0.0.1', '127.0.0.1/32'].includes(info.address),
    'SAFETY STOP: Database must be local.'
  );
  assert.equal(Number(info.version), 2);

  console.log('PASS: Approved local database.');

  // This test intentionally uses the same wallet service
  // as the dashboard, rather than Discord's real API.
  const { changeUnicoins } = await import(
    '../../src/utils/wallet.js'
  );

  const guildId = `1888888888${randomInt(100000000, 999999999)}`;
  const userId = `1777777777${randomInt(100000000, 999999999)}`;
  const adminId = `1666666666${randomInt(100000000, 999999999)}`;

  const creditId = randomUUID();
  const debitId = randomUUID();

  console.log('\n=== ADMIN WALLET TESTS ===');

  const credit = await changeUnicoins(pool, {
    guildId,
    userId,
    actorId: adminId,
    amount: 150,
    eventType: 'admin_credit',
    operationId: creditId,
    details: { source: 'admin_test' },
  });

  assert.equal(credit.newBalance, 150);
  console.log('PASS: Admin credit added 150 Unicoins.');

  const debit = await changeUnicoins(pool, {
    guildId,
    userId,
    actorId: adminId,
    amount: -40,
    eventType: 'admin_debit',
    operationId: debitId,
    details: { source: 'admin_test' },
  });

  assert.equal(debit.newBalance, 110);
  console.log('PASS: Admin debit removed 40 Unicoins.');

  await assert.rejects(
    changeUnicoins(pool, {
      guildId,
      userId,
      actorId: adminId,
      amount: -40,
      eventType: 'admin_debit',
      operationId: debitId,
    })
  );

  console.log('PASS: Duplicate adjustment blocked.');

  await assert.rejects(
    changeUnicoins(pool, {
      guildId,
      userId,
      actorId: adminId,
      amount: -999,
      eventType: 'admin_debit',
      operationId: randomUUID(),
    })
  );

  console.log('PASS: Negative balance prevented.');

  const account = await pool.query(
    `SELECT balance, data
     FROM economy
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );

  assert.equal(Number(account.rows[0].balance), 110);
  assert.equal(Number(account.rows[0].data.wallet), 110);

  const ledger = await pool.query(
    `SELECT event_type, amount, actor_id
     FROM cunvrs_economy_ledger
     WHERE guild_id = $1 AND user_id = $2
     ORDER BY id`,
    [guildId, userId]
  );

  assert.equal(ledger.rows.length, 2);
  assert.equal(ledger.rows[0].event_type, 'admin_credit');
  assert.equal(ledger.rows[1].event_type, 'admin_debit');
  assert.equal(ledger.rows[0].actor_id, adminId);
  assert.equal(ledger.rows[1].actor_id, adminId);

  console.log('PASS: Wallet matches database balance.');
  console.log('PASS: Both adjustments have admin audit entries.');

  console.log('\nALL ADMIN WALLET SERVICE TESTS PASSED!');
}

try {
  await main();
} catch (error) {
  console.error('TEST FAILED:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
