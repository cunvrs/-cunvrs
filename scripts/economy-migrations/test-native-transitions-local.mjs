import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const servicePath = path.resolve(
  'src/services/redemptions/redemptionService.js'
);

const tempPath = path.resolve(
  `src/services/redemptions/.local-transition-${randomUUID()}.mjs`
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
const wrongChannel = String(seed + 4n);
const redemptionId = randomUUID();

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

  // Confirm we're connected ONLY to localhost test DB.
  const identity = await pool.query(`
    SELECT current_database() AS database_name,
           inet_server_addr()::text AS server_address
  `);

  assert.equal(
    identity.rows[0].database_name,
    'cunvrs_restore_test'
  );

  // FIX: Accept localhost addresses with PostgreSQL masks.
  assert.match(
    identity.rows[0].server_address,
    /^(127\.0\.0\.1(?:\/32)?|::1(?:\/128)?)$/
  );

  const schema = await pool.query(
    'SELECT MAX(version) AS version FROM schema_migrations'
  );

  assert.equal(Number(schema.rows[0].version), 2);

  verified = true;

  console.log('PASS: Local test database verified.');
  console.log('PASS: Localhost address validated.');
  console.log('PASS: Economy schema version 2 verified.');

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
    `INSERT INTO cunvrs_redemptions
       (id, guild_id, user_id, channel_id,
        item_code, ticket_type, coins_reserved, status)
     VALUES ($1, $2, $3, $4, 'ugc_reward',
             'ugc', 12000, 'pending_approval')`,
    [redemptionId, guildId, ownerId, channelId]
  );

  const base = {
    guildId,
    redemptionId,
    staffId,
    staffAuthorized: true,
    action: 'approve'
  };

  const missingOwner = await transitionRedemption({
    ...base,
    channelId
  });

  assert.equal(missingOwner.success, false);
  console.log('PASS: Missing native ticket rejected.');

  await pool.query(
    `INSERT INTO cunvrs_ticketcord_owners
       (guild_id, channel_id, owner_id,
        verified_by, verification_method)
     VALUES ($1, $2, $3, $4, 'cunvrs_native_created')`,
    [guildId, channelId, ownerId, staffId]
  );

  const wrongTicket = await transitionRedemption({
    ...base,
    channelId: wrongChannel
  });

  assert.equal(wrongTicket.success, false);
  console.log('PASS: Wrong ticket rejected.');

  await assert.rejects(
    () => transitionRedemption({
      ...base,
      channelId,
      staffAuthorized: false
    }),
    /Manage Server permission required/i
  );

  console.log('PASS: Unauthorized manager rejected.');

  await assert.rejects(
    () => transitionRedemption({
      ...base,
      channelId,
      staffId: ownerId
    }),
    /Staff cannot process their own redemption/i
  );

  console.log('PASS: Self-approval blocked.');

  const before = await pool.query(
    'SELECT status FROM cunvrs_redemptions WHERE id=$1',
    [redemptionId]
  );

  assert.equal(before.rows[0].status, 'pending_approval');
  console.log('PASS: Rejected actions did not change status.');

  const approved = await transitionRedemption({
    ...base,
    channelId
  });

  assert.equal(approved.success, true);
  assert.equal(approved.status, 'approved');

  console.log('PASS: Approval saved to PostgreSQL.');

  const duplicate = await transitionRedemption({
    ...base,
    channelId
  });

  assert.equal(duplicate.success, false);
  console.log('PASS: Duplicate approval blocked.');

  const evidence = 'Local test delivery reference 12345';

  const delivered = await transitionRedemption({
    ...base,
    channelId,
    action: 'deliver',
    fulfillmentEvidence: evidence
  });

  assert.equal(delivered.success, true);
  assert.equal(delivered.status, 'delivered');

  const final = await pool.query(
    `SELECT status, details
     FROM cunvrs_redemptions
     WHERE id=$1 AND guild_id=$2`,
    [redemptionId, guildId]
  );

  assert.equal(final.rows[0].status, 'delivered');

  assert.ok(
    final.rows[0].details.history.some(
      entry =>
        entry.action === 'deliver' &&
        entry.fulfillmentEvidence === evidence
    )
  );

  console.log('PASS: Delivery evidence saved to PostgreSQL.');

  const duplicateDelivery = await transitionRedemption({
    ...base,
    channelId,
    action: 'deliver',
    fulfillmentEvidence: evidence
  });

  assert.equal(duplicateDelivery.success, false);

  console.log('PASS: Duplicate delivery blocked.');
  console.log('ALL LOCAL TRANSACTION TESTS PASSED!');

} finally {
  if (verified && pool) {
    try {
      await pool.query(
        'DELETE FROM cunvrs_redemptions WHERE id=$1',
        [redemptionId]
      );

      await pool.query(
        'DELETE FROM cunvrs_ticketcord_owners WHERE channel_id=$1',
        [channelId]
      );

      await pool.query(
        'DELETE FROM users WHERE id = ANY($1::varchar[])',
        [[ownerId, staffId]]
      );

      await pool.query(
        'DELETE FROM guilds WHERE id=$1',
        [guildId]
      );

      console.log('PASS: Test records cleaned up.');
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
