import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { ChannelType, PermissionFlagsBits as P } from 'discord.js';

import { createNativeRedemptionTicket } from '../../src/services/redemptions/nativeTicketService.js';
import { REDEMPTION_TICKET_CONFIG as config } from '../../src/services/redemptions/ticketConfig.js';

const pool = new pg.Pool({
  host: '127.0.0.1',
  port: 5432,
  database: 'cunvrs_restore_test',
  user: 'postgres',
  password: process.env.CUNVRS_LOCAL_DB_PASSWORD,
  connectionTimeoutMillis: 5000
});

const seed = 100000000000000000n +
  BigInt('0x' + randomBytes(7).toString('hex'));

const guildId = String(seed);
const botId = String(seed + 1n);
const ownerId = String(seed + 2n);
const failedId = String(seed + 3n);
const dbFailedId = String(seed + 4n);

const channels = new Map();
const createdIds = new Set();
let createCalls = 0;
let nextChannel = seed + 100n;
let rejectCreation = false;

const guild = {
  id: guildId,
  roles: {
    everyone: { id: guildId },
    fetch: async () =>
      new Map(config.staffRoleIds.map(id => [id, { id }]))
  },
  channels: {
    fetch: async id => {
      if (id === config.categoryId) {
        return { id, type: ChannelType.GuildCategory };
      }
      return channels.get(id) ?? null;
    },
    create: async options => {
      createCalls++;

      if (rejectCreation) {
        throw new Error('MOCK_DISCORD_CREATION_FAILED');
      }

      const id = String(nextChannel++);
      const channel = {
        id,
        parentId: options.parent,
        type: options.type,
        options,
        sentMessages: [],
        send: async function(message) {
          this.sentMessages.push(message);
          return { id: 'mock-message' };
        },
        delete: async () => {
          channels.delete(id);
        }
      };

      channels.set(id, channel);
      createdIds.add(id);
      return channel;
    }
  }
};

function interaction(userId) {
  return {
    guild,
    user: { id: userId },
    client: { user: { id: botId } },
    channelId: config.panelChannelId
  };
}

const previousFlag = process.env.CUNVRS_REDEMPTIONS_ENABLED;
const admin = await pool.connect();

try {
  const identity = await admin.query(`
    SELECT current_database() AS name,
           inet_server_addr()::text AS address
  `);

  assert.equal(identity.rows[0].name, 'cunvrs_restore_test');
  assert.match(
    identity.rows[0].address,
    /^(127\.0\.0\.1|::1)(\/32|\/128)?$/
  );

  await admin.query(
    'INSERT INTO guilds (id) VALUES ($1) ON CONFLICT DO NOTHING',
    [guildId]
  );

  for (const id of [botId, ownerId, failedId, dbFailedId]) {
    await admin.query(
      'INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING',
      [id]
    );
  }

  // Enable only inside this test process.
  process.env.CUNVRS_REDEMPTIONS_ENABLED = 'true';

  const results = await Promise.all([
    createNativeRedemptionTicket(interaction(ownerId), { pool }),
    createNativeRedemptionTicket(interaction(ownerId), { pool })
  ]);

  assert.equal(results.filter(r => r.created).length, 1);
  assert.equal(results[0].channelId, results[1].channelId);
  assert.equal(createCalls, 1);
  console.log('PASS: Concurrent clicks created exactly one ticket.');

  const channel = channels.get(results[0].channelId);
  assert.ok(channel);

  assert.equal(channel.sentMessages.length, 2);

  const welcome = channel.sentMessages[0];
  const staffPanel = channel.sentMessages[1];

  assert.match(welcome.content, /redemption ticket/i);
  assert.match(welcome.content, /\/shop buy/i);

  assert.equal(staffPanel.embeds.length, 1);
  assert.equal(staffPanel.components.length, 1);

  const buttons = staffPanel.components[0].components;

  assert.equal(buttons.length, 5);
  assert.equal(buttons[0].data.custom_id, 'cunvrs_redemption_claim');
  assert.equal(buttons[0].data.disabled, false);
  assert.ok(buttons.slice(1).every(button => button.data.disabled));

  console.log('PASS: Welcome message sent.');
  console.log('PASS: Staff controls sent after welcome.');
  console.log('PASS: Claim enabled; unfinished buttons disabled.');
  console.log('PASS: Both ticket messages validated.');


  const overwrites = channel.options.permissionOverwrites;
  const everyone = overwrites.find(o => o.id === guildId);
  const owner = overwrites.find(o => o.id === ownerId);
  const bot = overwrites.find(o => o.id === botId);

  assert.ok(everyone.deny.includes(P.ViewChannel));
  assert.ok(owner.allow.includes(P.ViewChannel));
  assert.ok(owner.allow.includes(P.SendMessages));
  assert.ok(bot.allow.includes(P.ManageChannels));

  for (const roleId of config.staffRoleIds) {
    const role = overwrites.find(o => o.id === roleId);
    assert.ok(role, `Missing staff role: ${roleId}`);
    assert.ok(role.allow.includes(P.ViewChannel));
  }

  console.log('PASS: Owner, bot and seven staff permissions configured.');
  console.log('PASS: Everyone role denied channel visibility.');

  const again = await createNativeRedemptionTicket(
    interaction(ownerId),
    { pool }
  );

  assert.equal(again.created, false);
  assert.equal(again.channelId, channel.id);
  assert.equal(createCalls, 1);
  console.log('PASS: Existing valid ticket reused.');

  channel.parentId = '111111111111111111';

  await assert.rejects(
    createNativeRedemptionTicket(interaction(ownerId), { pool }),
    /staff review/i
  );

  assert.equal(createCalls, 1);
  console.log('PASS: Moved ticket rejected without replacement.');

  channel.parentId = config.categoryId;

  rejectCreation = true;

  await assert.rejects(
    createNativeRedemptionTicket(interaction(failedId), { pool }),
    /MOCK_DISCORD_CREATION_FAILED/
  );

  rejectCreation = false;

  const noRecord = await admin.query(
    `SELECT COUNT(*)::int AS total
     FROM cunvrs_ticketcord_owners
     WHERE guild_id=$1 AND owner_id=$2`,
    [guildId, failedId]
  );

  assert.equal(noRecord.rows[0].total, 0);
  console.log('PASS: Discord creation failure saved no owner record.');

  // Inject a database failure after a mock channel is created.
  // This checks the real service's rollback/cleanup branch.
  const failingPool = {
    connect: async () => {
      const connection = await pool.connect();
      return {
        query: (sql, values) => {
          if (String(sql).includes('INSERT INTO cunvrs_ticketcord_owners')) {
            throw new Error('MOCK_DATABASE_INSERT_FAILED');
          }
          return connection.query(sql, values);
        },
        release: () => connection.release()
      };
    }
  };

  const beforeFailureChannels = channels.size;

  await assert.rejects(
    createNativeRedemptionTicket(
      interaction(dbFailedId),
      { pool: failingPool }
    ),
    /MOCK_DATABASE_INSERT_FAILED/
  );

  assert.equal(channels.size, beforeFailureChannels);

  const noDbRecord = await admin.query(
    `SELECT COUNT(*)::int AS total
     FROM cunvrs_ticketcord_owners
     WHERE guild_id=$1 AND owner_id=$2`,
    [guildId, dbFailedId]
  );

  assert.equal(noDbRecord.rows[0].total, 0);

  console.log('PASS: Failed database insert rolled back.');
  console.log('PASS: Incomplete Discord channel was deleted.');
  console.log('ALL NATIVE TICKET INTEGRATION TESTS PASSED!');

} finally {
  if (previousFlag === undefined) {
    delete process.env.CUNVRS_REDEMPTIONS_ENABLED;
  } else {
    process.env.CUNVRS_REDEMPTIONS_ENABLED = previousFlag;
  }

  try {
    // Clean up only records created with our fake guild ID.
    await admin.query(
      'DELETE FROM cunvrs_ticketcord_owners WHERE guild_id=$1',
      [guildId]
    );

    for (const id of [botId, ownerId, failedId, dbFailedId]) {
      await admin.query('DELETE FROM users WHERE id=$1', [id]);
    }

    await admin.query('DELETE FROM guilds WHERE id=$1', [guildId]);

    console.log('PASS: Temporary database records cleaned up.');
  } finally {
    admin.release();
    await pool.end();
  }
}
