
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import pg from 'pg';

import {
  settleMinigame,
  getGameCooldown,
} from '../../src/commands/Economy/modules/gameRewardService.js';

const password = process.env.CUNVRS_LOCAL_DB_PASSWORD;
if (!password) throw new Error('Local PostgreSQL password required.');

const pool = new pg.Pool({
  host: '127.0.0.1',
  port: 5432,
  database: 'cunvrs_restore_test',
  user: 'postgres',
  password,
  ssl: false,
});

const id = prefix => `${prefix}${randomInt(100000000, 999999999)}`;

const guildId = id('1888888888');

const games = [
  { name: 'wordle', coins: 200, xp: 25 },
  { name: 'tictactoe', coins: 75, xp: 10 },
  { name: 'fourinarow', coins: 150, xp: 20 },
];

async function main() {
  const { rows } = await pool.query(`
    SELECT current_database() AS db,
           inet_server_addr()::text AS address,
           (SELECT MAX(version) FROM schema_migrations) AS version
  `);

  assert.equal(rows[0].db, 'cunvrs_restore_test');
  assert.ok(['127.0.0.1', '127.0.0.1/32'].includes(rows[0].address));
  assert.equal(Number(rows[0].version), 2);

  console.log('PASS: Approved local test database.');

  for (const game of games) {
    console.log(`\n=== ${game.name.toUpperCase()} ===`);

    const userId = id('1777777777');

    const claim = options => settleMinigame(pool, {
      guildId,
      userId,
      interactionId: id('1666666666'),
      game: game.name,
      ...options,
    });

    const first = await claim({ won: true });

    assert.equal(first.cooldown, false);
    assert.equal(first.earned, game.coins);
    assert.equal(first.xpEarned, game.xp);

    console.log(`PASS: ${game.coins} Unicoins and ${game.xp} XP awarded.`);

    const cooldown = await getGameCooldown(pool, {
      guildId,
      userId,
      game: game.name,
    });

    assert.equal(cooldown.cooldown, true);

    const second = await claim({ won: true });
    assert.equal(second.cooldown, true);

    console.log('PASS: Second payout blocked.');

    const account = await pool.query(
      `SELECT balance, data
       FROM economy
       WHERE guild_id = $1 AND user_id = $2`,
      [guildId, userId]
    );

    assert.equal(Number(account.rows[0].balance), game.coins);
    assert.equal(Number(account.rows[0].data.wallet), game.coins);
    assert.equal(Number(account.rows[0].data.xp), game.xp);

    console.log('PASS: Wallet and XP verified.');

    const ledger = await pool.query(
      `SELECT amount
       FROM cunvrs_economy_ledger
       WHERE guild_id = $1
         AND user_id = $2
         AND event_type = $3`,
      [guildId, userId, `minigame_${game.name}`]
    );

    assert.equal(ledger.rows.length, 1);
    assert.equal(Number(ledger.rows[0].amount), game.coins);

    console.log('PASS: Exactly one ledger entry.');
  }

  console.log('\nALL THREE GAME REWARD TESTS PASSED!');
}

try {
  await main();
} catch (error) {
  console.error('TEST FAILED:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
