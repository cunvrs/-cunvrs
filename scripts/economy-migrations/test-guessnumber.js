
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import pg from 'pg';
import { playGuessNumber } from '../../src/commands/Economy/modules/minigameRewards.js';

const password = process.env.CUNVRS_LOCAL_DB_PASSWORD;

if (!password) {
  throw new Error('Local PostgreSQL password required.');
}

const pool = new pg.Pool({
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  password,
  database: 'cunvrs_restore_test',
  ssl: false,
  max: 3,
});

async function main() {
  const { rows } = await pool.query(`
    SELECT
      current_database() AS db,
      inet_server_addr()::text AS address,
      (SELECT MAX(version) FROM schema_migrations) AS version
  `);

  const info = rows[0];

  if (
    info.db !== 'cunvrs_restore_test' ||
    !['127.0.0.1', '127.0.0.1/32'].includes(info.address) ||
    Number(info.version) !== 2
  ) {
    throw new Error('SAFETY STOP: Not the local v2 database.');
  }

  console.log('PASS: Local test database verified.');

  const guildId = `1888888888${randomInt(100000000, 999999999)}`;
  const userId = `1777777777${randomInt(100000000, 999999999)}`;

  console.log('\n=== GUESS NUMBER TEST ===');

  const first = await playGuessNumber(pool, {
    guildId,
    userId,
    interactionId: `1777777777${randomInt(100000000, 999999999)}`,
    guess: 5,
  });

  assert.equal(first.cooldown, false);
  assert.ok(first.winningNumber >= 1 && first.winningNumber <= 10);
  assert.equal(first.won, first.winningNumber === 5);

  const expectedCoins = first.won ? 50 : 0;
  const expectedXp = first.won ? 10 : 0;

  assert.equal(first.earned, expectedCoins);
  assert.equal(first.xpEarned, expectedXp);

  console.log(`PASS: Game played (${first.won ? 'WIN' : 'LOSS'}).`);
  console.log(`Winning number: ${first.winningNumber}`);
  console.log(`Unicoins earned: ${first.earned}`);
  console.log(`XP earned: ${first.xpEarned}`);

  const retry = await playGuessNumber(pool, {
    guildId,
    userId,
    interactionId: `1777777777${randomInt(100000000, 999999999)}`,
    guess: 5,
  });

  assert.equal(retry.cooldown, true);
  console.log('PASS: Five-minute cooldown enforced.');

  const account = await pool.query(
    `SELECT balance, data FROM economy
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );

  const row = account.rows[0];

  assert.equal(Number(row.balance), expectedCoins);
  assert.equal(Number(row.data.wallet), expectedCoins);
  assert.equal(Number(row.data.xp), expectedXp);

  console.log('PASS: Wallet and XP saved correctly.');

  const ledger = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM cunvrs_economy_ledger
     WHERE guild_id = $1 AND user_id = $2
       AND event_type = 'minigame_guessnumber'`,
    [guildId, userId]
  );

  assert.equal(ledger.rows[0].total, first.won ? 1 : 0);

  console.log('PASS: Transaction ledger matches game outcome.');

  const limits = await pool.query(
    `SELECT repeatable_coins, minigame_coins
     FROM cunvrs_economy_daily_limits
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );

  assert.equal(limits.rows.length, 1);
  assert.equal(Number(limits.rows[0].repeatable_coins), expectedCoins);
  assert.equal(Number(limits.rows[0].minigame_coins), expectedCoins);

  console.log('PASS: Shared earning counters updated correctly.');
  console.log('\nALL GUESS NUMBER TESTS PASSED!');
}

try {
  await main();
} catch (error) {
  console.error('TEST FAILED:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
