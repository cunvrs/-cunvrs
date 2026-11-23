
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import pg from 'pg';
import {
  settleMinigame,
  getGameCooldown,
} from '../../src/commands/Economy/modules/gameRewardService.js';

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
  max: 4,
});

const id = prefix =>
  `${prefix}${randomInt(100000000, 999999999)}`;

const guildId = id('1888888888');
const userId = id('1777777777');

function play(game, won, user = userId) {
  return settleMinigame(pool, {
    guildId,
    userId: user,
    interactionId: id('1666666666'),
    game,
    won,
  });
}

async function checkBalance(user, expected) {
  const { rows } = await pool.query(
    `SELECT balance, data
     FROM economy
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, user]
  );

  assert.equal(Number(rows[0].balance), expected);
  assert.equal(Number(rows[0].data.wallet), expected);
}

async function main() {
  const { rows } = await pool.query(`
    SELECT current_database() AS db,
           inet_server_addr()::text AS address,
           (SELECT MAX(version)
            FROM schema_migrations) AS version
  `);

  const db = rows[0];

  assert.equal(db.db, 'cunvrs_restore_test');
  assert.ok(
    ['127.0.0.1', '127.0.0.1/32'].includes(db.address)
  );
  assert.equal(Number(db.version), 2);

  console.log('PASS: Approved local database.');

  console.log('\n=== TRIVIA TEST ===');

  const trivia = await play('trivia', true);

  assert.equal(trivia.cooldown, false);
  assert.equal(trivia.earned, 100);
  assert.equal(trivia.xpEarned, 15);

  await checkBalance(userId, 100);
  console.log('PASS: Trivia awarded 100 Unicoins and 15 XP.');

  const cooldown = await getGameCooldown(pool, {
    guildId,
    userId,
    game: 'trivia',
  });

  assert.equal(cooldown.cooldown, true);

  const retry = await play('trivia', true);

  assert.equal(retry.cooldown, true);

  await checkBalance(userId, 100);
  console.log('PASS: Trivia cooldown prevented double payment.');

  console.log('\n=== HANGMAN TEST ===');

  const hangman = await play('hangman', true);

  assert.equal(hangman.cooldown, false);
  assert.equal(hangman.earned, 150);
  assert.equal(hangman.xpEarned, 20);

  await checkBalance(userId, 250);
  console.log('PASS: Hangman awarded 150 Unicoins and 20 XP.');

  const hangmanRetry = await play('hangman', true);

  assert.equal(hangmanRetry.cooldown, true);
  await checkBalance(userId, 250);

  console.log('PASS: Hangman cooldown prevented double payment.');

  console.log('\n=== LOSS TEST ===');

  const loser = id('1777777777');

  const loss = await play('trivia', false, loser);

  assert.equal(loss.cooldown, false);
  assert.equal(loss.earned, 0);
  assert.equal(loss.xpEarned, 0);

  await checkBalance(loser, 0);
  console.log('PASS: Losing awarded nothing.');

  console.log('\n=== DAILY CAP TEST ===');

  const cappedUser = id('1777777777');

  // Create this temporary account through the game service.
  await play('trivia', false, cappedUser);

  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Detroit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  // Set a temporary test account near the daily minigame cap.
  await pool.query(
    `UPDATE cunvrs_economy_daily_limits
     SET repeatable_coins = 1480,
         minigame_coins = 1480
     WHERE guild_id = $1 AND user_id = $2
       AND local_day = $3`,
    [guildId, cappedUser, day]
  );

  await pool.query(
    `UPDATE economy
     SET data = jsonb_set(
       data,
       '{minigameCooldowns,trivia}',
       '0'::jsonb,
       true
     )
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, cappedUser]
  );

  const capped = await play('trivia', true, cappedUser);

  assert.equal(capped.earned, 20);
  assert.equal(capped.dailyMinigameCoins, 1500);

  await checkBalance(cappedUser, 20);
  console.log('PASS: Reward reduced to 20 at the daily cap.');

  const blocked = await play('hangman', true, cappedUser);

  assert.equal(blocked.earned, 0);
  assert.equal(blocked.xpEarned, 0);

  await checkBalance(cappedUser, 20);
  console.log('PASS: No coins awarded beyond 1,500.');

  console.log('\n=== LEDGER TEST ===');

  const { rows: ledger } = await pool.query(
    `SELECT event_type, amount
     FROM cunvrs_economy_ledger
     WHERE guild_id = $1 AND user_id = $2
     ORDER BY created_at`,
    [guildId, userId]
  );

  assert.equal(ledger.length, 2);
  assert.equal(
    ledger.reduce((sum, row) => sum + Number(row.amount), 0),
    250
  );

  console.log('PASS: Trivia and hangman ledger entries verified.');
  console.log('\nALL GAME REWARD TESTS PASSED!');
}

try {
  await main();
} catch (error) {
  console.error('\nTEST FAILED:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
