
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';

const password = process.env.CUNVRS_LOCAL_DB_PASSWORD;
if (!password) throw new Error('Local PostgreSQL password is missing.');

const url = new URL('postgresql://127.0.0.1:5432/cunvrs_restore_test');
url.username = 'postgres';
url.password = password;

Object.assign(process.env, {
  POSTGRES_URL: url.toString(),
  DATABASE_URL: url.toString(),
  POSTGRES_HOST: '127.0.0.1',
  POSTGRES_PORT: '5432',
  POSTGRES_USER: 'postgres',
  POSTGRES_PASSWORD: password,
  POSTGRES_DB: 'cunvrs_restore_test',
  POSTGRES_DATABASE: 'cunvrs_restore_test',
  PGHOST: '127.0.0.1',
  PGPORT: '5432',
  PGUSER: 'postgres',
  PGPASSWORD: password,
  PGDATABASE: 'cunvrs_restore_test',
  POSTGRES_SSL: 'false',
  PGSSLMODE: 'disable',
});

const { getPaymentPool } = await import(
  '../../src/commands/Economy/modules/paymentHandler.js'
);
const { setBirthday } = await import(
  '../../src/utils/database.js'
);
const birthdayClaim = (
  await import('../../src/commands/Birthday/modules/birthday_claim.js')
).default;

const pool = getPaymentPool();
const storage = new Map();

const client = {
  db: {
    async get(key, fallback = {}) {
      return structuredClone(storage.get(key) ?? fallback);
    },
    async set(key, value) {
      storage.set(key, structuredClone(value));
    },
  },
};

const snowflake = prefix =>
  `${prefix}${randomInt(100000000, 999999999)}`;

const guildId = snowflake('1888888888');
const userId = snowflake('1777777777');

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Detroit',
  month: 'numeric',
  day: 'numeric',
}).formatToParts(new Date());

const today = {
  month: Number(parts.find(x => x.type === 'month').value),
  day: Number(parts.find(x => x.type === 'day').value),
};

async function claim(user = userId) {
  const replies = [];

  const interaction = {
    guildId,
    user: { id: user },
    async deferReply() {},
    async editReply(payload) {
      replies.push(payload);
      return payload;
    },
  };

  await birthdayClaim.execute(interaction, {}, client);
  return JSON.stringify(replies);
}

async function wallet(user = userId) {
  const result = await pool.query(
    `SELECT balance, data
     FROM economy
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, user]
  );
  return result.rows[0] ?? null;
}

async function setRegistration(user, month, day, ageMs = 0) {
  assert.equal(
    await setBirthday(client, guildId, user, month, day),
    true
  );

  const key = [...storage.keys()].find(
    k => storage.get(k)?.[user]
  );

  assert.ok(key, 'Birthday storage key not found.');

  const birthdays = storage.get(key);
  birthdays[user].registeredAt = Date.now() - ageMs;
  storage.set(key, birthdays);
}

try {
  const check = await pool.query(
    `SELECT current_database() AS db,
            inet_server_addr()::text AS address,
            (SELECT MAX(version)
             FROM schema_migrations) AS version`
  );

  assert.equal(check.rows[0].db, 'cunvrs_restore_test');

  // PostgreSQL may return 127.0.0.1/32.
  assert.ok(
    ['127.0.0.1', '127.0.0.1/32'].includes(
      check.rows[0].address
    ),
    'Database must be local.'
  );

  assert.equal(Number(check.rows[0].version), 2);

  console.log('PASS: Connected to approved local database.');

  await setRegistration(userId, today.month, today.day);

  assert.match(await claim(), /not eligible yet/i);
  assert.equal(await wallet(), null);

  console.log('PASS: New registrations cannot claim immediately.');

  await setRegistration(
    userId,
    today.month,
    today.day,
    31 * 24 * 60 * 60 * 1000
  );

  assert.match(await claim(), /happy birthday/i);

  let account = await wallet();

  assert.equal(Number(account.balance), 1000);
  assert.equal(Number(account.data.wallet), 1000);

  console.log('PASS: Birthday claim credited 1,000 Unicoins.');
  console.log('PASS: Wallet balance matches stored wallet data.');

  assert.match(await claim(), /already claimed/i);

  account = await wallet();
  assert.equal(Number(account.balance), 1000);

  console.log('PASS: Second annual claim blocked.');

  const otherUser = snowflake('1777777777');
  const otherMonth = today.month === 12 ? 1 : today.month + 1;

  await setRegistration(
    otherUser,
    otherMonth,
    today.day,
    31 * 24 * 60 * 60 * 1000
  );

  assert.match(
    await claim(otherUser),
    /not your registered birthday/i
  );

  assert.equal(await wallet(otherUser), null);

  console.log('PASS: Claims blocked on the wrong birthday.');

  const ledger = await pool.query(
    `SELECT amount, balance_before, balance_after
     FROM cunvrs_economy_ledger
     WHERE guild_id = $1
       AND user_id = $2
       AND event_type = 'birthday_reward'`,
    [guildId, userId]
  );

  assert.equal(ledger.rows.length, 1);
  assert.equal(Number(ledger.rows[0].amount), 1000);
  assert.equal(Number(ledger.rows[0].balance_before), 0);
  assert.equal(Number(ledger.rows[0].balance_after), 1000);

  console.log('PASS: Exactly one birthday reward ledger entry.');
  console.log('\nALL BIRTHDAY CLAIM TESTS PASSED!');
} catch (error) {
  console.error('\nBIRTHDAY TEST FAILED:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
