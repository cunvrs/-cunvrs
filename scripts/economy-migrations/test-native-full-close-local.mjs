import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { ChannelType } from 'discord.js';

import {
  prepareNativeTicketForDeletion
} from '../../src/services/redemptions/nativeCloseLifecycle.js';

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

const channels = [
  String(seed + 4n),
  String(seed + 5n)
];

const archiveIds = [
  String(seed + 6n),
  String(seed + 7n)
];

const originalFlags = {
  enabled: process.env.CUNVRS_REDEMPTIONS_ENABLED,
  staff: process.env.CUNVRS_REDEMPTION_STAFF_BUTTONS_ENABLED,
  deletion: process.env.CUNVRS_REDEMPTION_DELETION_ENABLED
};

let verified = false;
let deletionCount = 0;
let uploadCount = 0;

function scenario(index) {
  const channelId = channels[index];
  const archiveId = archiveIds[index];
  const archiveMessages = new Map();

  let messageFetches = 0;
  let deleted = false;

  const channel = {
    id: channelId,
    name: 'redemption-local-test',
    type: ChannelType.GuildText,
    parentId: config.categoryId,

    messages: {
      fetch: async () => {
        messageFetches++;

        if (messageFetches > 1) {
          return new Map();
        }

        const messageId = String(seed + 20n + BigInt(index));

        return new Map([
          [messageId, {
            id: messageId,
            author: {
              id: ownerId,
              username: 'local-test-user'
            },
            content: 'Redemption completed.',
            createdAt: new Date(),
            createdTimestamp: Date.now(),
            attachments: new Map(),
            embeds: []
          }]
        ]);
      }
    },

    delete: async () => {
      if (deleted) {
        throw new Error('Duplicate deletion attempted.');
      }

      deletionCount++;
      deleted = true;
    }
  };

  const logChannel = {
    id: config.logChannelId,
    guild: { id: guildId },
    type: ChannelType.GuildText,

    send: async payload => {
      uploadCount++;

      assert.equal(typeof payload.content, 'string');
      assert.match(
        payload.content,
        /CUNVRS_NATIVE_ARCHIVE_ONLY_V1/
      );

      assert.ok(
        payload.content.includes(`**ticket:** ${channelId}`)
      );

      assert.equal(payload.files.length, 1);

      const attachmentName =
        `cunvrs-redemption-${channelId}.txt`;

      const archiveMessage = {
        id: archiveId,
        author: { id: botId },
        content: payload.content,
        attachments: new Map([
          ['file', { name: attachmentName }]
        ])
      };

      archiveMessages.set(archiveId, archiveMessage);

      return archiveMessage;
    },

    messages: {
      fetch: async id => archiveMessages.get(id) ?? null
    }
  };

  const interaction = {
    guildId,
    channelId,
    guild: { id: guildId },
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

  return {
    interaction,
    logChannel,
    wasDeleted: () => deleted
  };
}

async function closingState(channelId) {
  const found = await pool.query(
    `SELECT state, archive_message_id
     FROM cunvrs_native_redemption_closures
     WHERE guild_id=$1 AND channel_id=$2`,
    [guildId, channelId]
  );

  return found.rows[0] ?? null;
}

try {
  // No writes until the isolated database is verified.
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

  console.log('PASS: Isolated PostgreSQL database verified.');
  console.log('PASS: Deleting-state migration available.');

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

  for (const channelId of channels) {
    await pool.query(
      `INSERT INTO cunvrs_ticketcord_owners
         (guild_id, channel_id, owner_id,
          verified_by, verification_method)
       VALUES ($1, $2, $3, $4,
               'cunvrs_native_created')`,
      [guildId, channelId, ownerId, staffId]
    );
  }

  // Flags exist only in this test process.
  process.env.CUNVRS_REDEMPTIONS_ENABLED = 'true';
  process.env.CUNVRS_REDEMPTION_STAFF_BUTTONS_ENABLED = 'true';
  process.env.CUNVRS_REDEMPTION_DELETION_ENABLED = 'false';

  const archiveOnly = scenario(0);

  const first = await prepareNativeTicketForDeletion(
    archiveOnly.interaction,
    {
      pool,
      logChannel: archiveOnly.logChannel
    }
  );

  assert.equal(first.success, true);
  assert.equal(first.archived, true);
  assert.equal(first.deleted, false);
  assert.equal(archiveOnly.wasDeleted(), false);

  assert.equal(
    (await closingState(channels[0])).state,
    'archived'
  );

  console.log('PASS: Archive-only close completed.');
  console.log('PASS: Disabled deletion keeps ticket open.');

  // Run the full archive → delete → closed sequence.
  process.env.CUNVRS_REDEMPTION_DELETION_ENABLED = 'true';

  const full = scenario(1);

  const second = await prepareNativeTicketForDeletion(
    full.interaction,
    {
      pool,
      logChannel: full.logChannel
    }
  );

  assert.equal(second.success, true);
  assert.equal(second.archived, true);
  assert.equal(second.deleted, true);
  assert.equal(full.wasDeleted(), true);

  const stored = await closingState(channels[1]);

  assert.equal(stored.state, 'closed');
  assert.equal(stored.archive_message_id, archiveIds[1]);

  console.log('PASS: Full Close Ticket lifecycle completed.');
  console.log('PASS: Transcript ID persisted.');
  console.log('PASS: Ticket marked closed in PostgreSQL.');
  console.log('PASS: Mock Discord channel deleted exactly once.');

  const previousUploads = uploadCount;

  const retry = await prepareNativeTicketForDeletion(
    full.interaction,
    {
      pool,
      logChannel: full.logChannel
    }
  );

  assert.equal(retry.success, false);
  assert.equal(uploadCount, previousUploads);
  assert.equal(deletionCount, 1);

  console.log('PASS: Duplicate close cannot reupload or delete.');

  assert.equal(uploadCount, 2);
  assert.equal(deletionCount, 1);

  console.log('ALL FULL CLOSE LIFECYCLE TESTS PASSED!');

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
    ['deletion', 'CUNVRS_REDEMPTION_DELETION_ENABLED']
  ]) {
    if (originalFlags[key] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalFlags[key];
    }
  }

  await pool.end();
}
