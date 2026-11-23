import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';

const password = process.env.CUNVRS_LOCAL_DB_PASSWORD;
if (!password) throw new Error('Missing local database password.');

const url = new URL('postgresql://127.0.0.1:5432/cunvrs_restore_test');
url.username = 'postgres';
url.password = password;

Object.assign(process.env, {
  POSTGRES_URL: url.toString(),
  DATABASE_URL: url.toString(),
  POSTGRES_HOST: '127.0.0.1',
  POSTGRES_PORT: '5432',
  POSTGRES_USER: 'postgres',
  POSTGRES_PASSWORD: password,
  POSTGRES_DB: 'cunvrs_restore_test',
  POSTGRES_DATABASE: 'cunvrs_restore_test',
  POSTGRES_SSL: 'false',
  PGHOST: '127.0.0.1',
  PGPORT: '5432',
  PGUSER: 'postgres',
  PGPASSWORD: password,
  PGDATABASE: 'cunvrs_restore_test',
  PGSSLMODE: 'disable'
});

const { getPaymentPool } = await import(
  '../../src/commands/Economy/modules/paymentHandler.js'
);
const {
  requestRedemption,
  transitionRedemption
} = await import(
  '../../src/services/redemptions/redemptionService.js'
);

const pool = getPaymentPool();
const id = prefix => prefix + randomInt(100000000, 999999999);

const guildId = id('1888888888');
const userId = id('1777777777');
const staffId = id('1666666666');
const channelId = id('1555555555');

async function wallet() {
  const { rows } = await pool.query(
    'SELECT balance,data FROM economy WHERE guild_id=$1 AND user_id=$2',
    [guildId, userId]
  );
  assert.equal(Number(rows[0].balance), Number(rows[0].data.wallet));
  return Number(rows[0].balance);
}

try {
  const { rows } = await pool.query(`
    SELECT current_database() AS db,
      inet_server_addr()::text AS address,
      (SELECT MAX(version) FROM schema_migrations) AS version
  `);

  assert.equal(rows[0].db, 'cunvrs_restore_test');
  assert.ok(['127.0.0.1', '127.0.0.1/32'].includes(rows[0].address));
  assert.equal(Number(rows[0].version), 2);
  console.log('PASS: Local test database confirmed.');

  await pool.query(
    'INSERT INTO guilds(id) VALUES($1) ON CONFLICT DO NOTHING',
    [guildId]
  );

  for (const value of [userId, staffId]) {
    await pool.query(
      'INSERT INTO users(id) VALUES($1) ON CONFLICT DO NOTHING',
      [value]
    );
  }

  await pool.query(
    `INSERT INTO economy(guild_id,user_id,balance,bank,data)
     VALUES($1,$2,50000,0,$3::jsonb)`,
    [guildId, userId, JSON.stringify({
      wallet: 50000, bank: 0, level: 1
    })]
  );

  await pool.query(
    `INSERT INTO cunvrs_ticketcord_owners
       (guild_id, channel_id, owner_id, verified_by, verification_method)
     VALUES ($1, $2, $3, $4, 'cunvrs_native_created')`,
    [guildId, channelId, userId, staffId]
  );

  const makeRequest = () => requestRedemption({
    guildId, channelId, userId,
    interactionId: id('1444444444'),
    itemCode: 'ugc_reward'
  });

  // Two different Discord interactions at the same instant.
  const attempts = await Promise.all([
    makeRequest(),
    makeRequest()
  ]);

  const successful = attempts.filter(x => x.success);
  assert.equal(successful.length, 1);
  assert.equal(await wallet(), 38000);

  console.log('PASS: Concurrent requests reserve coins once.');

  const redemptionId = successful[0].redemptionId;

  // Two different staff decisions arriving simultaneously.
  const decline = () => transitionRedemption({
    guildId, channelId, redemptionId, staffId,
    staffAuthorized: true,
    action: 'decline'
  });

  const declines = await Promise.all([
    decline(),
    decline()
  ]);

  assert.equal(declines.filter(x => x.success).length, 1);
  assert.equal(await wallet(), 50000);

  console.log('PASS: Concurrent declines refund coins once.');

  const ledger = await pool.query(
    `SELECT event_type,amount
     FROM cunvrs_economy_ledger
     WHERE guild_id=$1 AND user_id=$2
       AND event_type IN ('redemption_hold','redemption_refund')`,
    [guildId, userId]
  );

  assert.equal(ledger.rows.length, 2);
  assert.equal(
    ledger.rows.reduce((sum, r) => sum + Number(r.amount), 0),
    0
  );

  console.log('PASS: Ledger matches final wallet.');
  console.log('\nALL REDEMPTION CONCURRENCY TESTS PASSED!');
} catch (error) {
  console.error('\nCONCURRENCY TEST FAILED:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
