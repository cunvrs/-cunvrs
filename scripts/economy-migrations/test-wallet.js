
import pg from 'pg';
import { randomUUID, randomInt } from 'node:crypto';

import {
  changeUnicoins,
  transferUnicoins,
  formatUnicoins,
} from '../../src/utils/wallet.js';

const password = process.env.CUNVRS_LOCAL_DB_PASSWORD;

if (!password) {
  console.error('Missing local database password.');
  process.exit(1);
}

const pool = new pg.Pool({
  host: '127.0.0.1',
  port: 5432,
  database: 'cunvrs_restore_test',
  user: 'postgres',
  password,
  ssl: false,
  max: 3,
  connectionTimeoutMillis: 5000,
});

// Generate separate test-only accounts for every run.
const suffix = String(randomInt(100000000, 999999999));

const guildId = '1253406230999863316';
const alice = `1999999999${suffix}`;
const bob = `1888888888${suffix}`;

async function main() {
  const target = await pool.query(
    'SELECT current_database() AS name, inet_server_addr()::text AS address'
  );

  const { name, address } = target.rows[0];

  if (
    name !== 'cunvrs_restore_test' ||
    !['127.0.0.1', '127.0.0.1/32'].includes(address)
  ) {
    throw new Error('Wrong database. Tests cancelled.');
  }

  console.log('Testing local Unicoin wallets...');

  const earned = await changeUnicoins(pool, {
    guildId,
    userId: alice,
    amount: 100,
    eventType: 'test_reward',
    operationId: randomUUID(),
  });

  console.log('Earned:', formatUnicoins(earned.newBalance));

  const paymentId = randomUUID();

  const payment = await transferUnicoins(pool, {
    guildId,
    fromUserId: alice,
    toUserId: bob,
    amount: 40,
    operationId: paymentId,
  });

  console.log(
    'Payment complete:',
    formatUnicoins(payment.amount)
  );

  let duplicateBlocked = false;

  try {
    await transferUnicoins(pool, {
      guildId,
      fromUserId: alice,
      toUserId: bob,
      amount: 40,
      operationId: paymentId,
    });
  } catch {
    duplicateBlocked = true;
  }

  if (!duplicateBlocked) {
    throw new Error('Duplicate payment was not rejected!');
  }

  const spent = await changeUnicoins(pool, {
    guildId,
    userId: alice,
    amount: -10,
    eventType: 'test_purchase',
    operationId: randomUUID(),
  });

  let overspendBlocked = false;

  try {
    await changeUnicoins(pool, {
      guildId,
      userId: alice,
      amount: -1000,
      eventType: 'test_purchase',
      operationId: randomUUID(),
    });
  } catch {
    overspendBlocked = true;
  }

  if (!overspendBlocked) {
    throw new Error('Overspending was not rejected!');
  }

  const result = await pool.query(
    `SELECT user_id, balance
     FROM economy
     WHERE guild_id = $1 AND user_id = ANY($2::text[])`,
    [guildId, [alice, bob]]
  );

  const balances = new Map(
    result.rows.map(row => [row.user_id, Number(row.balance)])
  );

  if (balances.get(alice) !== 50 || balances.get(bob) !== 40) {
    throw new Error('Final wallet balances are incorrect!');
  }

  console.log('Duplicate payments blocked: YES');
  console.log('Overspending blocked: YES');
  console.log('Alice:', formatUnicoins(spent.newBalance));
  console.log('Bob:', formatUnicoins(balances.get(bob)));
  console.log('ALL WALLET TESTS PASSED!');
}

try {
  await main();
} catch (error) {
  console.error('WALLET TEST FAILED:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
