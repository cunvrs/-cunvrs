import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { ChannelType } from 'discord.js';

import {
  deleteArchivedNativeTicket
} from '../../src/services/redemptions/nativeTicketDeletion.js';

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
const channelId = String(seed + 3n);
const badChannelId = String(seed + 4n);
const archiveId = String(seed + 5n);
const badArchiveId = String(seed + 6n);
const botId = String(seed + 7n);

const oldEnabled = process.env.CUNVRS_REDEMPTIONS_ENABLED;
const oldDeletion =
  process.env.CUNVRS_REDEMPTION_DELETION_ENABLED;

let verified = false;
let deleteCount = 0;

function fakeInteraction(id) {
  return {
    guildId,
    channelId: id,
    user: { id: staffId },
    client: { user: { id: botId } },
    member: {
      roles: [config.staffRoleIds[0]]
    },
    memberPermissions: {
      has: () => true
    },
    channel: {
      id,
      type: ChannelType.GuildText,
      parentId: config.categoryId,
      delete: async () => {
        // This function is a mock, not the Discord API.
        deleteCount++;
      }
    }
  };
}

const logChannel = {
  id: config.logChannelId,
  guild: { id: guildId },
  type: ChannelType.GuildText,
  messages: {
    fetch: async id => {
      if (id === badArchiveId) {
        return {
          content: 'Invalid archive',
          attachments: new Map()
        };
      }

      assert.equal(id, archiveId);

      return {
        id: archiveId,
        author: { id: botId },
        content: `CUNVRS_NATIVE_ARCHIVE_ONLY_V1\n**ticket:** ${channelId}`,
        attachments: new Map([
          ['file', {
            name: `cunvrs-redemption-${channelId}.txt`
          }]
        ])
      };
    }
  }
};

async function closureState(id) {
  const result = await pool.query(
    `SELECT state, archive_message_id
     FROM cunvrs_native_redemption_closures
     WHERE guild_id=$1 AND channel_id=$2`,
    [guildId, id]
  );

  return result.rows[0] ?? null;
}

try {
  // No database writes before these checks.
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

  const table = await pool.query(
    `SELECT to_regclass(
      'public.cunvrs_native_redemption_closures'
    ) AS name`
  );

  assert.ok(table.rows[0].name);

  verified = true;

  console.log('PASS: Isolated PostgreSQL database verified.');

  const migration = fs.readFileSync(
    'scripts/economy-migrations/004_native_redemption_deleting_state.sql',
    'utf8'
  ).replace(/^\uFEFF/, '');

  assert.match(
    migration,
    /state IN \('closing', 'archived', 'deleting', 'closed'\)/
  );

  await pool.query(migration);

  console.log('PASS: Migration 004 applied locally.');

  await pool.query(
    'INSERT INTO guilds(id) VALUES($1)',
    [guildId]
  );

  for (const id of [ownerId, staffId]) {
    await pool.query(
      'INSERT INTO users(id) VALUES($1)',
      [id]
    );
  }

  for (const [id, messageId] of [
    [channelId, archiveId],
    [badChannelId, badArchiveId]
  ]) {
    await pool.query(
      `INSERT INTO cunvrs_ticketcord_owners
         (guild_id, channel_id, owner_id,
          verified_by, verification_method)
       VALUES ($1, $2, $3, $4,
               'cunvrs_native_created')`,
      [guildId, id, ownerId, staffId]
    );

    await pool.query(
      `INSERT INTO cunvrs_native_redemption_closures
         (guild_id, channel_id, owner_id,
          started_by, state, archive_message_id)
       VALUES ($1, $2, $3, $4, 'archived', $5)`,
      [guildId, id, ownerId, staffId, messageId]
    );
  }

  process.env.CUNVRS_REDEMPTIONS_ENABLED = 'true';
  process.env.CUNVRS_REDEMPTION_DELETION_ENABLED = 'true';

  const results = await Promise.all([
    deleteArchivedNativeTicket(
      fakeInteraction(channelId),
      { pool, logChannel }
    ),
    deleteArchivedNativeTicket(
      fakeInteraction(channelId),
      { pool, logChannel }
    )
  ]);

  assert.equal(
    results.filter(result => result.success).length,
    1
  );

  assert.equal(
    results.filter(result => !result.success).length,
    1
  );

  assert.equal(deleteCount, 1);

  assert.equal(
    (await closureState(channelId)).state,
    'closed'
  );

  console.log('PASS: Only one simultaneous deletion succeeded.');
  console.log('PASS: Closed state persisted to PostgreSQL.');
  console.log('PASS: Fake channel deletion happened exactly once.');

  await assert.rejects(
    () => deleteArchivedNativeTicket(
      fakeInteraction(badChannelId),
      { pool, logChannel }
    ),
    /Verified transcript archive missing/
  );

  assert.equal(deleteCount, 1);

  assert.equal(
    (await closureState(badChannelId)).state,
    'deleting'
  );

  console.log('PASS: Invalid archive prevented deletion.');
  console.log('PASS: Failed verification retained recovery state.');

  process.env.CUNVRS_REDEMPTION_DELETION_ENABLED = 'false';

  await assert.rejects(
    () => deleteArchivedNativeTicket(
      fakeInteraction(channelId),
      { pool, logChannel }
    ),
    /Ticket deletion is disabled/
  );

  console.log('PASS: Feature flag blocks deletion.');
  console.log('ALL LOCAL DELETION TRANSACTION TESTS PASSED!');

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

  if (oldEnabled === undefined) {
    delete process.env.CUNVRS_REDEMPTIONS_ENABLED;
  } else {
    process.env.CUNVRS_REDEMPTIONS_ENABLED = oldEnabled;
  }

  if (oldDeletion === undefined) {
    delete process.env.CUNVRS_REDEMPTION_DELETION_ENABLED;
  } else {
    process.env.CUNVRS_REDEMPTION_DELETION_ENABLED = oldDeletion;
  }

  await pool.end();
}
