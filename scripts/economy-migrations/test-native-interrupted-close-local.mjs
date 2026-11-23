import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { ChannelType } from 'discord.js';

import {
  prepareNativeTicketForDeletion
} from '../../src/services/redemptions/nativeCloseLifecycle.js';

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
const channelId = String(seed + 4n);
const archiveId = String(seed + 5n);
const messageId = String(seed + 6n);

const flags = {
  enabled: process.env.CUNVRS_REDEMPTIONS_ENABLED,
  staff: process.env.CUNVRS_REDEMPTION_STAFF_BUTTONS_ENABLED,
  deletion: process.env.CUNVRS_REDEMPTION_DELETION_ENABLED,
  recovery: process.env.CUNVRS_REDEMPTION_RECOVERY_ENABLED
};

let verified = false;
let deleted = false;
let deleteCalls = 0;
let uploadCalls = 0;
let failedUpdate = false;
let fetchCalls = 0;

const archiveMessages = new Map();

const channel = {
  id: channelId,
  name: 'redemption-recovery-test',
  type: ChannelType.GuildText,
  parentId: config.categoryId,

  messages: {
    fetch: async () => {
      fetchCalls++;

      return fetchCalls === 1
        ? new Map([
            [messageId, {
              id: messageId,
              author: {
                id: ownerId,
                username: 'test-owner'
              },
              content: 'Redemption complete.',
              createdAt: new Date(),
              createdTimestamp: Date.now(),
              attachments: new Map(),
              embeds: []
            }]
          ])
        : new Map();
    }
  },

  delete: async () => {
    if (deleted) {
      throw new Error('A second deletion was attempted.');
    }

    deleteCalls++;
    deleted = true;
  }
};

const logChannel = {
  id: config.logChannelId,
  guild: { id: guildId },
  type: ChannelType.GuildText,

  send: async payload => {
    uploadCalls++;

    assert.match(
      payload.content,
      /CUNVRS_NATIVE_ARCHIVE_ONLY_V1/
    );

    assert.ok(
      payload.content.includes(`**ticket:** ${channelId}`)
    );

    assert.equal(payload.files.length, 1);

    const archive = {
      id: archiveId,
      author: { id: botId },
      content: payload.content,
      attachments: new Map([
        ['transcript', {
          name: `cunvrs-redemption-${channelId}.txt`
        }]
      ])
    };

    archiveMessages.set(archiveId, archive);

    return archive;
  },

  messages: {
    fetch: async id => archiveMessages.get(id) ?? null
  }
};

const interaction = {
  guildId,
  channelId,
  guild: {
    id: guildId,
    channels: {
      fetch: async id => {
        assert.equal(id, channelId);
        return deleted ? null : channel;
      }
    }
  },
  channel,
  user: { id: staffId },
  member: {
    roles: [config.staffRoleIds[0]]
  },
  memberPermissions: {
    has: () => true
  },
  client: {
    user: { id: botId },
    channels: {
      fetch: async id => {
        assert.equal(id, config.logChannelId);
        return logChannel;
      }
    }
  }
};

// Forward every query to REAL PostgreSQL, except the one
// deliberately failed final closed-state update.
const interruptedPool = {
  query: (...args) => pool.query(...args),

  connect: async () => {
    const db = await pool.connect();

    return {
      query: (...args) => {
        const sql = String(args[0]);

        if (
          deleted &&
          !failedUpdate &&
          sql.includes("SET state='closed'")
        ) {
          failedUpdate = true;

          throw new Error(
            'SIMULATED_POSTGRES_CLOSED_UPDATE_FAILURE'
          );
        }

        return db.query(...args);
      },

      release: () => db.release()
    };
  }
};

async function readState() {
  const result = await pool.query(
    `SELECT state, archive_message_id
     FROM cunvrs_native_redemption_closures
     WHERE guild_id=$1 AND channel_id=$2`,
    [guildId, channelId]
  );

  return result.rows[0] ?? null;
}

try {
  // Absolutely no writes before checking the isolated DB.
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
    'SELECT MAX(version) AS version FROM schema_migrations'
  );

  assert.equal(Number(schema.rows[0].version), 2);

  const constraint = await pool.query(`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid =
      'cunvrs_native_redemption_closures'::regclass
      AND conname =
        'cunvrs_native_redemption_closures_state_check'
  `);

  assert.equal(constraint.rows.length, 1);
  assert.match(constraint.rows[0].definition, /deleting/);

  verified = true;

  console.log('PASS: Isolated PostgreSQL verified.');

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

  await pool.query(
    `INSERT INTO cunvrs_ticketcord_owners
       (guild_id, channel_id, owner_id,
        verified_by, verification_method)
     VALUES ($1, $2, $3, $4, 'cunvrs_native_created')`,
    [guildId, channelId, ownerId, staffId]
  );

  process.env.CUNVRS_REDEMPTIONS_ENABLED = 'true';
  process.env.CUNVRS_REDEMPTION_STAFF_BUTTONS_ENABLED = 'true';
  process.env.CUNVRS_REDEMPTION_DELETION_ENABLED = 'true';
  process.env.CUNVRS_REDEMPTION_RECOVERY_ENABLED = 'true';

  const result = await prepareNativeTicketForDeletion(
    interaction,
    { pool: interruptedPool, logChannel }
  );

  assert.equal(result.success, false);
  assert.equal(result.recoveryRequired, true);
  assert.equal(failedUpdate, true);
  assert.equal(deleted, true);
  assert.equal(deleteCalls, 1);
  assert.equal(uploadCalls, 1);

  const interrupted = await readState();

  assert.equal(interrupted.state, 'deleting');
  assert.equal(
    interrupted.archive_message_id,
    archiveId
  );

  console.log('PASS: Simulated database failure occurred AFTER deletion.');
  console.log('PASS: Channel was deleted once (mock only).');
  console.log('PASS: PostgreSQL preserved deleting state.');
  console.log('PASS: Transcript archive ID remained recorded.');

  // Recovery uses the real pool; failure injection is over.
  const recovery = await reconcileDeletedNativeTicket(
    interaction,
    { pool, logChannel }
  );

  assert.equal(recovery.success, true);
  assert.equal(recovery.state, 'closed');
  assert.equal(recovery.deletedAgain, false);

  const recovered = await readState();

  assert.equal(recovered.state, 'closed');
  assert.equal(
    recovered.archive_message_id,
    archiveId
  );
  assert.equal(deleteCalls, 1);
  assert.equal(uploadCalls, 1);

  console.log('PASS: Recovery reconciled the ticket to closed.');
  console.log('PASS: No second channel deletion.');
  console.log('PASS: No duplicate transcript upload.');

  const retry = await reconcileDeletedNativeTicket(
    interaction,
    { pool, logChannel }
  );

  assert.equal(retry.success, false);
  assert.equal(deleteCalls, 1);

  console.log('PASS: Duplicate recovery rejected.');
  console.log('ALL INTERRUPTED DELETION RECOVERY TESTS PASSED!');

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

      console.log('PASS: Synthetic test records cleaned up.');
    } catch (error) {
      console.error('CLEANUP ERROR:', error.message);
      process.exitCode = 1;
    }
  }

  for (const [key, name] of [
    ['enabled', 'CUNVRS_REDEMPTIONS_ENABLED'],
    ['staff', 'CUNVRS_REDEMPTION_STAFF_BUTTONS_ENABLED'],
    ['deletion', 'CUNVRS_REDEMPTION_DELETION_ENABLED'],
    ['recovery', 'CUNVRS_REDEMPTION_RECOVERY_ENABLED']
  ]) {
    if (flags[key] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = flags[key];
    }
  }

  await pool.end();
}
