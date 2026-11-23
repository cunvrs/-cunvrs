import pg from 'pg';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ChannelType } from 'discord.js';

import { claimNativeRedemptionTicket } from '../../src/services/redemptions/nativeTicketClaims.js';
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
const ownerId = String(seed + 1n);
const staffA = String(seed + 2n);
const staffB = String(seed + 3n);
const channelId = String(seed + 4n);
const invalidChannelId = String(seed + 5n);

const userIds = [ownerId, staffA, staffB];
const previousFlag = process.env.CUNVRS_REDEMPTIONS_ENABLED;

function interaction(staffId, ticketId = channelId) {
  return {
    guildId,
    channelId: ticketId,
    channel: {
      id: ticketId,
      type: ChannelType.GuildText,
      parentId: config.categoryId
    },
    user: { id: staffId },
    member: {
      roles: [config.staffRoleIds[0]]
    },
    memberPermissions: {
      has: () => false
    }
  };
}

let identityVerified = false;

try {
  const identity = await pool.query(`
    SELECT current_database() AS name,
           inet_server_addr()::text AS address
  `);

  assert.equal(identity.rows[0].name, 'cunvrs_restore_test');
  assert.match(
    identity.rows[0].address,
    /^(127\.0\.0\.1|::1)(\/32|\/128)?$/
  );

  identityVerified = true;

  const sql = fs.readFileSync(
    'scripts/economy-migrations/002_native_redemption_claims.sql',
    'utf8'
  ).replace(/^\uFEFF/, '');

  await pool.query(sql);
  console.log('PASS: Claims migration applied to local test database.');

  await pool.query(
    'INSERT INTO guilds (id) VALUES ($1)',
    [guildId]
  );

  for (const id of userIds) {
    await pool.query(
      'INSERT INTO users (id) VALUES ($1)',
      [id]
    );
  }

  await pool.query(
    `INSERT INTO cunvrs_ticketcord_owners
       (guild_id, channel_id, owner_id, verified_by, verification_method)
     VALUES ($1, $2, $3, $4, 'cunvrs_native_created')`,
    [guildId, channelId, ownerId, staffA]
  );

  process.env.CUNVRS_REDEMPTIONS_ENABLED = 'true';

  const results = await Promise.all([
    claimNativeRedemptionTicket(interaction(staffA), { pool }),
    claimNativeRedemptionTicket(interaction(staffB), { pool })
  ]);

  assert.equal(
    results.filter(result => result.claimed).length,
    1
  );

  assert.equal(results[0].claimedBy, results[1].claimedBy);
  assert.ok([staffA, staffB].includes(results[0].claimedBy));

  console.log('PASS: Two staff members attempted to claim.');
  console.log('PASS: Exactly one staff member won the claim.');

  const saved = await pool.query(
    `SELECT claimed_by
     FROM cunvrs_native_redemption_claims
     WHERE channel_id = $1`,
    [channelId]
  );

  assert.equal(saved.rows.length, 1);
  assert.equal(saved.rows[0].claimed_by, results[0].claimedBy);

  console.log('PASS: Claim persisted correctly in PostgreSQL.');

  const again = await claimNativeRedemptionTicket(
    interaction(staffB),
    { pool }
  );

  assert.equal(again.claimed, false);
  assert.equal(again.claimedBy, saved.rows[0].claimed_by);

  console.log('PASS: Repeated claims preserve the original claimant.');

  await assert.rejects(
    claimNativeRedemptionTicket(
      interaction(staffA, invalidChannelId),
      { pool }
    ),
    /not registered/i
  );

  console.log('PASS: Unregistered native tickets cannot be claimed.');
  console.log('ALL NATIVE TICKET CLAIM DATABASE TESTS PASSED!');

} finally {
  if (previousFlag === undefined) {
    delete process.env.CUNVRS_REDEMPTIONS_ENABLED;
  } else {
    process.env.CUNVRS_REDEMPTIONS_ENABLED = previousFlag;
  }

  try {
    if (
      identityVerified &&
      (await pool.query(
        "SELECT to_regclass('public.cunvrs_native_redemption_claims') AS table_name"
      )).rows[0].table_name
    ) {
      await pool.query(
        'DELETE FROM cunvrs_native_redemption_claims WHERE channel_id = $1',
        [channelId]
      );

      await pool.query(
        'DELETE FROM cunvrs_ticketcord_owners WHERE channel_id = $1',
        [channelId]
      );

      for (const id of userIds) {
        await pool.query(
          'DELETE FROM users WHERE id = $1',
          [id]
        );
      }

      await pool.query(
        'DELETE FROM guilds WHERE id = $1',
        [guildId]
      );

      console.log('PASS: Temporary test records cleaned up.');
    }
  } finally {
    await pool.end();
  }
}
