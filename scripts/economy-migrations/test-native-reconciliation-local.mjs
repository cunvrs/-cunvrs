import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { ChannelType } from 'discord.js';

import {
  reconcileDeletedNativeTicket
} from '../../src/services/redemptions/nativeCloseReconcile.js';

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
const staffId = String(seed + 2n);
const botId = String(seed + 3n);
const goodChannelId = String(seed + 4n);
const forgedChannelId = String(seed + 5n);
const existingChannelId = String(seed + 6n);
const goodArchiveId = String(seed + 7n);
const forgedArchiveId = String(seed + 8n);
const existingArchiveId = String(seed + 9n);

const previousFlag =
  process.env.CUNVRS_REDEMPTION_RECOVERY_ENABLED;

let verified = false;
let channelDeleteCalls = 0;

function makeInteraction(channelId, channelExists = false) {
  return {
    guildId,
    channelId,
    guild: {
      id: guildId,
      channels: {
        fetch: async id => {
          assert.equal(id, channelId);

          return channelExists
            ? {
                id: channelId,
                delete: async () => {
                  channelDeleteCalls++;
                  throw new Error('Mock deletion forbidden.');
                }
              }
            : null;
        }
      }
    },
    client: {
      user: { id: botId }
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

const archiveById = new Map([
  [goodArchiveId, goodChannelId],
  [forgedArchiveId, forgedChannelId],
  [existingArchiveId, existingChannelId]
]);

const logChannel = {
  id: config.logChannelId,
  guild: { id: guildId },
  type: ChannelType.GuildText,
  messages: {
    fetch: async id => {
      const channelId = archiveById.get(id);

      assert.ok(channelId, 'Unknown synthetic archive ID.');

      return {
        id,
        author: {
          id: id === forgedArchiveId
            ? '999999999999999999'
            : botId
        },
        content:
          'CUNVRS_NATIVE_ARCHIVE_ONLY_V1\n' +
          `**ticket:** ${channelId}`,
        attachments: new Map([
          ['file', {
            name: `cunvrs-redemption-${channelId}.txt`
          }]
        ])
      };
    }
  }
};

async function state(channelId) {
  const result = await pool.query(
    `SELECT state, archive_message_id
     FROM cunvrs_native_redemption_closures
     WHERE guild_id=$1 AND channel_id=$2`,
    [guildId, channelId]
  );

  return result.rows[0] ?? null;
}

try {
  // Validate the exact local database before writing.
  const identity = await pool.query(`
    SELECT current_database() AS name,
           inet_server_addr()::text AS address
  `);

  assert.equal(
    identity.rows[0].name,
    'cunvrs_restore_test'
  );

  assert.match(
    identity.rows[0].address,
    /^(127\.0\.0\.1(?:\/32)?|::1(?:\/128)?)$/
  );

  const schema = await pool.query(
    'SELECT MAX(version) AS version FROM schema_migrations'
  );

  assert.equal(Number(schema.rows[0].version), 2);

  const constraints = await pool.query(`
    SELECT pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    WHERE c.conrelid =
      'cunvrs_native_redemption_closures'::regclass
      AND c.conname =
        'cunvrs_native_redemption_closures_state_check'
  `);

  assert.equal(constraints.rows.length, 1);
  assert.match(
    constraints.rows[0].definition,
    /deleting/
  );

  verified = true;

  console.log('PASS: Verified isolated PostgreSQL database.');
  console.log('PASS: Migration 004 deleting state available.');

  await pool.query(
    'INSERT INTO guilds(id) VALUES($1)',
    [guildId]
  );

  for (const id of [ownerId, staffId, botId]) {
    await pool.query(
      'INSERT INTO users(id) VALUES($1)',
      [id]
    );
  }

  for (const [channelId, archiveId] of [
    [goodChannelId, goodArchiveId],
    [forgedChannelId, forgedArchiveId],
    [existingChannelId, existingArchiveId]
  ]) {
    await pool.query(
      `INSERT INTO cunvrs_ticketcord_owners
         (guild_id,channel_id,owner_id,
          verified_by,verification_method)
       VALUES ($1,$2,$3,$4,'cunvrs_native_created')`,
      [guildId, channelId, ownerId, staffId]
    );

    await pool.query(
      `INSERT INTO cunvrs_native_redemption_closures
         (guild_id,channel_id,owner_id,
          started_by,state,archive_message_id)
       VALUES ($1,$2,$3,$4,'deleting',$5)`,
      [guildId, channelId, ownerId, staffId, archiveId]
    );
  }

  process.env.CUNVRS_REDEMPTION_RECOVERY_ENABLED =
    'true';

  const good = makeInteraction(goodChannelId);

  const result = await reconcileDeletedNativeTicket(
    good,
    { pool, logChannel }
  );

  assert.equal(result.success, true);
  assert.equal(result.state, 'closed');
  assert.equal(result.deletedAgain, false);
  assert.equal((await state(goodChannelId)).state, 'closed');

  console.log('PASS: Missing channel reconciled to closed.');

  const retry = await reconcileDeletedNativeTicket(
    good,
    { pool, logChannel }
  );

  assert.equal(retry.success, false);
  assert.equal((await state(goodChannelId)).state, 'closed');

  console.log('PASS: Duplicate reconciliation rejected.');

  await assert.rejects(
    () => reconcileDeletedNativeTicket(
      makeInteraction(forgedChannelId),
      { pool, logChannel }
    ),
    /Archive identity could not be verified/
  );

  assert.equal(
    (await state(forgedChannelId)).state,
    'deleting'
  );

  console.log('PASS: Forged archive rejected by PostgreSQL workflow.');
  console.log('PASS: Forged archive retains deleting state.');

  const existing = await reconcileDeletedNativeTicket(
    makeInteraction(existingChannelId, true),
    { pool, logChannel }
  );

  assert.equal(existing.success, false);
  assert.equal(
    (await state(existingChannelId)).state,
    'deleting'
  );

  console.log('PASS: Existing ticket cannot be reconciled.');

  process.env.CUNVRS_REDEMPTION_RECOVERY_ENABLED =
    'false';

  await assert.rejects(
    () => reconcileDeletedNativeTicket(
      makeInteraction(existingChannelId),
      { pool, logChannel }
    ),
    /recovery is disabled/i
  );

  assert.equal(channelDeleteCalls, 0);

  console.log('PASS: Disabled recovery remains inaccessible.');
  console.log('PASS: No Discord deletion methods called.');
  console.log('ALL LOCAL RECOVERY TRANSACTION TESTS PASSED!');

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
        [[ownerId, staffId, botId]]
      );

      await pool.query(
        'DELETE FROM guilds WHERE id=$1',
        [guildId]
      );

      console.log('PASS: Synthetic records cleaned up.');
    } catch (error) {
      console.error('CLEANUP ERROR:', error.message);
      process.exitCode = 1;
    }
  }

  if (previousFlag === undefined) {
    delete process.env.CUNVRS_REDEMPTION_RECOVERY_ENABLED;
  } else {
    process.env.CUNVRS_REDEMPTION_RECOVERY_ENABLED =
      previousFlag;
  }

  await pool.end();
}
