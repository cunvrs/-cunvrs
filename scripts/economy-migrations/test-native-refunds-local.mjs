import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const servicePath = path.resolve(
  'src/services/redemptions/redemptionService.js'
);

const tempPath = path.resolve(
  `src/services/redemptions/.refund-test-${randomUUID()}.mjs`
);

const original = fs.readFileSync(servicePath, 'utf8');

const target =
  "import { getPaymentPool } from '../../commands/Economy/modules/paymentHandler.js';";

assert.equal(original.split(target).length, 2);

const injection = `
import pg from 'pg';

export const localTestPool = new pg.Pool({
  host: '127.0.0.1',
  port: 5432,
  database: 'cunvrs_restore_test',
  user: 'postgres',
  password: process.env.CUNVRS_LOCAL_DB_PASSWORD,
  connectionTimeoutMillis: 5000
});

function getPaymentPool() {
  return localTestPool;
}
`;

const seed = 100000000000000000n +
  BigInt('0x' + randomBytes(6).toString('hex'));

const guildId = String(seed);
const ownerId = String(seed + 1n);
const staffA = String(seed + 2n);
const staffB = String(seed + 3n);
const channelId = String(seed + 4n);
const wrongChannel = String(seed + 5n);

const pendingId = randomUUID();
const approvedId = randomUUID();

const refundAmount = 12000;
const initialWallet = 1000;

let pool;
let verified = false;

try {
  fs.writeFileSync(
    tempPath,
    original.replace(target, injection),
    { flag: 'wx' }
  );

  const module = await import(pathToFileURL(tempPath).href);

  pool = module.localTestPool;
  const { transitionRedemption } = module;

  // Confirm exact local test database before any writes.
  const identity = await pool.query(`
    SELECT current_database() AS database_name,
           inet_server_addr()::text AS server_address
  `);

  assert.equal(
    identity.rows[0].database_name,
    'cunvrs_restore_test'
  );

  assert.match(
    identity.rows[0].server_address,
    /^(127\.0\.0\.1(?:\/32)?|::1(?:\/128)?)$/
  );

  const schema = await pool.query(
    'SELECT MAX(version) AS version FROM schema_migrations'
  );

  assert.equal(Number(schema.rows[0].version), 2);

  verified = true;

  console.log('PASS: Isolated local database verified.');
  console.log('PASS: Economy schema version 2 verified.');

  await pool.query(
    'INSERT INTO guilds (id) VALUES ($1)',
    [guildId]
  );

  for (const id of [ownerId, staffA, staffB]) {
    await pool.query(
      'INSERT INTO users (id) VALUES ($1)',
      [id]
    );
  }

  await pool.query(
    `INSERT INTO economy
       (guild_id, user_id, balance, bank, data)
     VALUES ($1, $2, $3, 0, $4::jsonb)`,
    [
      guildId,
      ownerId,
      initialWallet,
      JSON.stringify({
        wallet: initialWallet,
        bank: 0,
        level: 1
      })
    ]
  );

  await pool.query(
    `INSERT INTO cunvrs_ticketcord_owners
       (guild_id, channel_id, owner_id,
        verified_by, verification_method)
     VALUES ($1, $2, $3, $4, 'cunvrs_native_created')`,
    [guildId, channelId, ownerId, staffA]
  );

  for (const [id, status] of [
    [pendingId, 'pending_approval'],
    [approvedId, 'approved']
  ]) {
    await pool.query(
      `INSERT INTO cunvrs_redemptions
         (id, guild_id, user_id, channel_id,
          item_code, ticket_type, coins_reserved, status)
       VALUES ($1, $2, $3, $4, 'ugc_reward',
               'ugc', $5, $6)`,
      [id, guildId, ownerId, channelId, refundAmount, status]
    );
  }

  async function wallet() {
    const result = await pool.query(
      `SELECT balance, data
       FROM economy
       WHERE guild_id=$1 AND user_id=$2`,
      [guildId, ownerId]
    );

    return result.rows[0];
  }

  async function refunds() {
    const result = await pool.query(
      `SELECT operation_id, amount,
              balance_before, balance_after, details
       FROM cunvrs_economy_ledger
       WHERE guild_id=$1 AND user_id=$2
         AND event_type='redemption_refund'`,
      [guildId, ownerId]
    );

    return result.rows;
  }

  const base = {
    guildId,
    channelId,
    staffId: staffA,
    staffAuthorized: true,
    action: 'decline',
    redemptionId: pendingId
  };

  const wrongTicket = await transitionRedemption({
    ...base,
    channelId: wrongChannel
  });

  assert.equal(wrongTicket.success, false);

  await assert.rejects(
    () => transitionRedemption({
      ...base,
      staffAuthorized: false
    }),
    /Manage Server permission required/i
  );

  await assert.rejects(
    () => transitionRedemption({
      ...base,
      staffId: ownerId
    }),
    /Staff cannot process their own redemption/i
  );

  assert.equal(Number((await wallet()).balance), initialWallet);
  assert.equal((await refunds()).length, 0);

  console.log('PASS: Invalid declines cannot refund Unicoins.');

  // Two authorized staff members decline simultaneously.
  const results = await Promise.all([
    transitionRedemption({
      ...base,
      staffId: staffA
    }),
    transitionRedemption({
      ...base,
      staffId: staffB
    })
  ]);

  assert.equal(
    results.filter(result => result.success).length,
    1
  );

  assert.equal(
    results.filter(result => !result.success).length,
    1
  );

  const afterPending = await wallet();

  assert.equal(
    Number(afterPending.balance),
    initialWallet + refundAmount
  );

  assert.equal(
    Number(afterPending.data.wallet),
    initialWallet + refundAmount
  );

  let ledger = await refunds();

  assert.equal(ledger.length, 1);
  assert.equal(Number(ledger[0].amount), refundAmount);
  assert.equal(
    Number(ledger[0].balance_before),
    initialWallet
  );
  assert.equal(
    Number(ledger[0].balance_after),
    initialWallet + refundAmount
  );

  console.log('PASS: Simultaneous declines refunded exactly once.');
  console.log('PASS: Wallet balance and saved wallet data match.');
  console.log('PASS: One correct refund ledger entry created.');

  const retry = await transitionRedemption(base);

  assert.equal(retry.success, false);
  assert.equal((await refunds()).length, 1);

  console.log('PASS: Repeated decline cannot issue another refund.');

  // An already-approved redemption may also be declined.
  const approvedDecline = await transitionRedemption({
    ...base,
    redemptionId: approvedId
  });

  assert.equal(approvedDecline.success, true);
  assert.equal(approvedDecline.status, 'declined');

  const finalWallet = await wallet();

  assert.equal(
    Number(finalWallet.balance),
    initialWallet + refundAmount * 2
  );

  assert.equal(
    Number(finalWallet.data.wallet),
    initialWallet + refundAmount * 2
  );

  ledger = await refunds();

  assert.equal(ledger.length, 2);
  assert.equal(
    new Set(ledger.map(row => row.operation_id)).size,
    2
  );

  const statuses = await pool.query(
    `SELECT id, status FROM cunvrs_redemptions
     WHERE id = ANY($1::uuid[])`,
    [[pendingId, approvedId]]
  );

  assert.equal(statuses.rows.length, 2);
  assert.ok(
    statuses.rows.every(row => row.status === 'declined')
  );

  console.log('PASS: Approved redemption decline refunded correctly.');
  console.log('PASS: Both redemptions marked declined.');
  console.log('PASS: Refund ledger has two unique transactions.');
  console.log('ALL LOCAL REFUND TESTS PASSED!');

} finally {
  if (verified && pool) {
    try {
      await pool.query(
        `DELETE FROM cunvrs_economy_ledger
         WHERE guild_id=$1`,
        [guildId]
      );

      await pool.query(
        `DELETE FROM cunvrs_redemptions
         WHERE guild_id=$1`,
        [guildId]
      );

      await pool.query(
        `DELETE FROM economy
         WHERE guild_id=$1`,
        [guildId]
      );

      await pool.query(
        `DELETE FROM cunvrs_ticketcord_owners
         WHERE guild_id=$1`,
        [guildId]
      );

      await pool.query(
        `DELETE FROM users
         WHERE id = ANY($1::varchar[])`,
        [[ownerId, staffA, staffB]]
      );

      await pool.query(
        'DELETE FROM guilds WHERE id=$1',
        [guildId]
      );

      console.log('PASS: Temporary refund records cleaned up.');
    } catch (error) {
      console.error('CLEANUP ERROR:', error.message);
      process.exitCode = 1;
    }
  }

  if (pool) await pool.end();

  if (fs.existsSync(tempPath)) {
    fs.unlinkSync(tempPath);
  }
}
