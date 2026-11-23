import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { ChannelType } from 'discord.js';

import {
  beginNativeTicketClosing,
  cancelNativeTicketClosing
} from '../../src/services/redemptions/nativeClosingState.js';

import {
  REDEMPTION_TICKET_CONFIG as config
} from '../../src/services/redemptions/ticketConfig.js';

const pool = new pg.Pool({
  host: '127.0.0.1',
  port: 5432,
  database: 'cunvrs_restore_test',
  user: 'postgres',
  password: process.env.CUNVRS_LOCAL_DB_PASSWORD,
  connectionTimeoutMillis: 5000
});

const seed = 100000000000000000n +
  BigInt('0x' + randomBytes(6).toString('hex'));

const guildId = String(seed);
const ownerId = String(seed + 1n);
const staffA = String(seed + 2n);
const staffB = String(seed + 3n);
const channelId = String(seed + 4n);

const oldFlag = process.env.CUNVRS_REDEMPTIONS_ENABLED;

let verified = false;

function interaction(staffId) {
  return {
    guildId,
    channelId,
    channel: {
      id: channelId,
      type: ChannelType.GuildText,
      parentId: config.categoryId
    },
    user: { id: staffId },
    member: { roles: [config.staffRoleIds[0]] },
    memberPermissions: { has: () => true }
  };
}

try {
  const identity = await pool.query(`
    SELECT current_database() AS name,
           inet_server_addr()::text AS address
  `);

  assert.equal(identity.rows[0].name, 'cunvrs_restore_test');

  assert.match(
    identity.rows[0].address,
    /^(127\.0\.0\.1(?:\/32)?|::1(?:\/128)?)$/
  );

  const schema = await pool.query(
    `SELECT to_regclass(
       'public.cunvrs_native_redemption_closures'
     ) AS table_name`
  );

  assert.ok(schema.rows[0].table_name);

  verified = true;
  process.env.CUNVRS_REDEMPTIONS_ENABLED = 'true';

  console.log('PASS: Local closing-state table verified.');

  await pool.query(
    'INSERT INTO guilds(id) VALUES($1)',
    [guildId]
  );

  for (const id of [ownerId, staffA, staffB]) {
    await pool.query(
      'INSERT INTO users(id) VALUES($1)',
      [id]
    );
  }

  await pool.query(
    `INSERT INTO cunvrs_ticketcord_owners
       (guild_id,channel_id,owner_id,verified_by,verification_method)
     VALUES($1,$2,$3,$4,'cunvrs_native_created')`,
    [guildId, channelId, ownerId, staffA]
  );

  // Two staff members attempt closing simultaneously.
  const results = await Promise.all([
    beginNativeTicketClosing(interaction(staffA), { pool }),
    beginNativeTicketClosing(interaction(staffB), { pool })
  ]);

  assert.equal(
    results.filter(result => result.success).length,
    1
  );

  assert.equal(
    results.filter(result => !result.success).length,
    1
  );

  console.log('PASS: Exactly one staff member acquired closing state.');

  const stored = await pool.query(
    `SELECT state, started_by
     FROM cunvrs_native_redemption_closures
     WHERE guild_id=$1 AND channel_id=$2`,
    [guildId, channelId]
  );

  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].state, 'closing');

  const winningStaff = stored.rows[0].started_by;
  const losingStaff = winningStaff === staffA ? staffB : staffA;

  console.log('PASS: Closing state persisted.');

  const wrongCancel = await cancelNativeTicketClosing(
    interaction(losingStaff),
    { pool }
  );

  assert.equal(wrongCancel.success, false);

  console.log('PASS: Another staff member cannot cancel the lock.');

  const cancelled = await cancelNativeTicketClosing(
    interaction(winningStaff),
    { pool }
  );

  assert.equal(cancelled.success, true);

  console.log('PASS: Original staff member can release closing state.');

  const reopened = await beginNativeTicketClosing(
    interaction(staffA),
    { pool }
  );

  assert.equal(reopened.success, true);

  console.log('PASS: Closing can restart after cancellation.');

  await cancelNativeTicketClosing(interaction(staffA), { pool });

  const missingOwner = await pool.query(
    `DELETE FROM cunvrs_ticketcord_owners
     WHERE guild_id=$1 AND channel_id=$2`,
    [guildId, channelId]
  );

  assert.equal(missingOwner.rowCount, 1);

  const rejected = await beginNativeTicketClosing(
    interaction(staffA),
    { pool }
  );

  assert.equal(rejected.success, false);

  console.log('PASS: Unverified ticket cannot enter closing state.');

  const final = await pool.query(
    `SELECT COUNT(*)::integer AS count
     FROM cunvrs_native_redemption_closures
     WHERE guild_id=$1`,
    [guildId]
  );

  assert.equal(final.rows[0].count, 0);

  console.log('PASS: Failed close created no closing record.');
  console.log('ALL LOCAL CLOSING TRANSACTION TESTS PASSED!');

} finally {
  if (verified) {
    try {
      await pool.query(
        'DELETE FROM cunvrs_native_redemption_closures WHERE guild_id=$1',
        [guildId]
      );

      await pool.query(
        'DELETE FROM cunvrs_ticketcord_owners WHERE guild_id=$1',
        [guildId]
      );

      await pool.query(
        'DELETE FROM users WHERE id = ANY($1::varchar[])',
        [[ownerId, staffA, staffB]]
      );

      await pool.query(
        'DELETE FROM guilds WHERE id=$1',
        [guildId]
      );

      console.log('PASS: Synthetic closing records cleaned up.');
    } catch (error) {
      console.error('CLEANUP ERROR:', error.message);
      process.exitCode = 1;
    }
  }

  if (oldFlag === undefined) {
    delete process.env.CUNVRS_REDEMPTIONS_ENABLED;
  } else {
    process.env.CUNVRS_REDEMPTIONS_ENABLED = oldFlag;
  }

  await pool.end();
}
