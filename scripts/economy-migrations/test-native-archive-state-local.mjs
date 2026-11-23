import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { ChannelType } from 'discord.js';

import {
  markNativeTicketArchived
} from '../../src/services/redemptions/nativeArchiveState.js';

import {
  beginNativeTicketClosing
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
const archiveMessageId = String(seed + 5n);
const secondArchiveId = String(seed + 6n);

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
    member: {
      roles: [config.staffRoleIds[0]]
    },
    memberPermissions: {
      has: () => true
    }
  };
}

async function archiveRow() {
  const result = await pool.query(
    `SELECT state, started_by, archive_message_id
     FROM cunvrs_native_redemption_closures
     WHERE guild_id=$1 AND channel_id=$2`,
    [guildId, channelId]
  );

  return result.rows[0] ?? null;
}

try {
  // Strict identity check before any database changes.
  const identity = await pool.query(`
    SELECT current_database() AS name,
           inet_server_addr()::text AS address
  `);

  assert.equal(identity.rows[0].name, 'cunvrs_restore_test');

  assert.match(
    identity.rows[0].address,
    /^(127\.0\.0\.1(?:\/32)?|::1(?:\/128)?)$/
  );

  const table = await pool.query(
    `SELECT to_regclass(
      'public.cunvrs_native_redemption_closures'
    ) AS name`
  );

  assert.ok(table.rows[0].name);

  const version = await pool.query(
    'SELECT MAX(version) AS version FROM schema_migrations'
  );

  assert.equal(Number(version.rows[0].version), 2);

  verified = true;
  process.env.CUNVRS_REDEMPTIONS_ENABLED = 'true';

  console.log('PASS: Verified local PostgreSQL test database.');
  console.log('PASS: Closing-state table exists.');

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
       (guild_id, channel_id, owner_id,
        verified_by, verification_method)
     VALUES ($1, $2, $3, $4, 'cunvrs_native_created')`,
    [guildId, channelId, ownerId, staffA]
  );

  // Create the closing state using the real service.
  const started = await beginNativeTicketClosing(
    interaction(staffA),
    { pool }
  );

  assert.equal(started.success, true);
  assert.equal((await archiveRow()).state, 'closing');

  console.log('PASS: Closing state created in PostgreSQL.');

  // Another staff member cannot record the archive.
  const wrongStaff = await markNativeTicketArchived(
    interaction(staffB),
    archiveMessageId,
    { pool }
  );

  assert.equal(wrongStaff.success, false);
  assert.equal((await archiveRow()).archive_message_id, null);

  console.log('PASS: Another staff member cannot record archive.');

  // Invalid Discord message IDs must fail.
  await assert.rejects(
    () => markNativeTicketArchived(
      interaction(staffA),
      'invalid-id',
      { pool }
    ),
    /Invalid native ticket archive request/
  );

  assert.equal((await archiveRow()).state, 'closing');

  console.log('PASS: Invalid archive message ID rejected.');

  // Correct staff archives successfully.
  const archived = await markNativeTicketArchived(
    interaction(staffA),
    archiveMessageId,
    { pool }
  );

  assert.equal(archived.success, true);
  assert.equal(archived.archiveMessageId, archiveMessageId);

  const saved = await archiveRow();

  assert.equal(saved.state, 'archived');
  assert.equal(saved.started_by, staffA);
  assert.equal(saved.archive_message_id, archiveMessageId);

  console.log('PASS: Archive state committed to PostgreSQL.');
  console.log('PASS: Discord archive message ID persisted.');

  // A retry cannot overwrite the original archive reference.
  const retry = await markNativeTicketArchived(
    interaction(staffA),
    secondArchiveId,
    { pool }
  );

  assert.equal(retry.success, false);

  const afterRetry = await archiveRow();

  assert.equal(afterRetry.state, 'archived');
  assert.equal(
    afterRetry.archive_message_id,
    archiveMessageId
  );

  console.log('PASS: Duplicate archive update rejected.');
  console.log('PASS: Original archive reference preserved.');

  // Disabled feature must block further archive updates.
  process.env.CUNVRS_REDEMPTIONS_ENABLED = 'false';

  await assert.rejects(
    () => markNativeTicketArchived(
      interaction(staffA),
      secondArchiveId,
      { pool }
    ),
    /Redemptions are disabled/
  );

  console.log('PASS: Feature flag protects archive updates.');
  console.log('ALL LOCAL ARCHIVE STATE TESTS PASSED!');

} finally {
  if (verified) {
    try {
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
        `DELETE FROM users
         WHERE id = ANY($1::varchar[])`,
        [[ownerId, staffA, staffB]]
      );

      await pool.query(
        'DELETE FROM guilds WHERE id=$1',
        [guildId]
      );

      console.log('PASS: Synthetic archive records cleaned up.');
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
