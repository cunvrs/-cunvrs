import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const migrationPath =
  'scripts/economy-migrations/003_native_redemption_closures.sql';

const servicePath = path.resolve(
  'src/services/redemptions/redemptionService.js'
);

const tempPath = path.resolve(
  `src/services/redemptions/.closing-test-${randomUUID()}.mjs`
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
const staffId = String(seed + 2n);
const channelId = String(seed + 3n);
const interactionId = String(seed + 4n);

let pool;
let verified = false;

try {
  assert.match(
    original,
    /CUNVRS_NATIVE_CLOSING_GUARD_V1/
  );

  fs.writeFileSync(
    tempPath,
    original.replace(target, injection),
    { flag: 'wx' }
  );

  const testModule = await import(
    pathToFileURL(tempPath).href
  );

  pool = testModule.localTestPool;

  const { requestRedemption } = testModule;

  // Verify database identity BEFORE any writes.
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

  console.log('PASS: Verified isolated local database.');
  console.log('PASS: Economy schema version 2 verified.');

  // Migration 003 is additive and does not alter wallet rows.
  const migration = fs.readFileSync(
    migrationPath,
    'utf8'
  ).replace(/^\uFEFF/, '');

  assert.match(
    migration,
    /CREATE TABLE IF NOT EXISTS cunvrs_native_redemption_closures/
  );

  assert.match(
    migration,
    /state IN \('closing', 'archived', 'closed'\)/
  );

  await pool.query(migration);

  console.log('PASS: Migration 003 applied to local test DB.');

  await pool.query(
    'INSERT INTO guilds (id) VALUES ($1)',
    [guildId]
  );

  for (const id of [ownerId, staffId]) {
    await pool.query(
      'INSERT INTO users (id) VALUES ($1)',
      [id]
    );
  }

  await pool.query(
    `INSERT INTO economy
       (guild_id, user_id, balance, bank, data)
     VALUES ($1, $2, 50000, 0,
             '{"wallet":50000,"bank":0,"level":1}'::jsonb)`,
    [guildId, ownerId]
  );

  await pool.query(
    `INSERT INTO cunvrs_ticketcord_owners
       (guild_id, channel_id, owner_id,
        verified_by, verification_method)
     VALUES ($1, $2, $3, $4,
             'cunvrs_native_created')`,
    [guildId, channelId, ownerId, staffId]
  );

  await pool.query(
    `INSERT INTO cunvrs_native_redemption_closures
       (guild_id, channel_id, owner_id,
        state, started_by)
     VALUES ($1, $2, $3, 'closing', $4)`,
    [guildId, channelId, ownerId, staffId]
  );

  console.log('PASS: Synthetic ticket entered closing state.');

  const result = await requestRedemption({
    guildId,
    channelId,
    userId: ownerId,
    interactionId,
    itemCode: 'ugc_reward'
  });

  assert.equal(result.success, false);

  assert.equal(
    result.reason,
    'This redemption ticket is closing or closed.'
  );

  console.log('PASS: New redemption blocked during closing.');

  const wallet = await pool.query(
    `SELECT balance, data
     FROM economy
     WHERE guild_id=$1 AND user_id=$2`,
    [guildId, ownerId]
  );

  assert.equal(Number(wallet.rows[0].balance), 50000);
  assert.equal(Number(wallet.rows[0].data.wallet), 50000);

  console.log('PASS: No Unicoins deducted.');

  const redemptions = await pool.query(
    `SELECT COUNT(*)::integer AS count
     FROM cunvrs_redemptions
     WHERE guild_id=$1`,
    [guildId]
  );

  assert.equal(redemptions.rows[0].count, 0);

  console.log('PASS: No new redemption created.');

  const ledger = await pool.query(
    `SELECT COUNT(*)::integer AS count
     FROM cunvrs_economy_ledger
     WHERE guild_id=$1`,
    [guildId]
  );

  assert.equal(ledger.rows[0].count, 0);

  console.log('PASS: No financial ledger entry created.');

  // Verify archived and closed states also block requests.
  for (const state of ['archived', 'closed']) {
    await pool.query(
      `UPDATE cunvrs_native_redemption_closures
       SET state=$3
       WHERE guild_id=$1 AND channel_id=$2`,
      [guildId, channelId, state]
    );

    const blocked = await requestRedemption({
      guildId,
      channelId,
      userId: ownerId,
      interactionId,
      itemCode: 'ugc_reward'
    });

    assert.equal(blocked.success, false);

    console.log(`PASS: ${state} ticket blocks redemption.`);
  }

  console.log('ALL LOCAL CLOSING GUARD TESTS PASSED!');

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
        `DELETE FROM cunvrs_native_redemption_closures
         WHERE guild_id=$1`,
        [guildId]
      );

      await pool.query(
        `DELETE FROM cunvrs_ticketcord_owners
         WHERE guild_id=$1`,
        [guildId]
      );

      await pool.query(
        'DELETE FROM economy WHERE guild_id=$1',
        [guildId]
      );

      await pool.query(
        'DELETE FROM users WHERE id = ANY($1::varchar[])',
        [[ownerId, staffId]]
      );

      await pool.query(
        'DELETE FROM guilds WHERE id=$1',
        [guildId]
      );

      console.log('PASS: Synthetic test records cleaned up.');
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
