
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';

const password = process.env.CUNVRS_LOCAL_DB_PASSWORD;

if (!password) {
  throw new Error('Local PostgreSQL password is required.');
}

const localUrl =
  `postgresql://postgres:${encodeURIComponent(password)}` +
  '@127.0.0.1:5432/cunvrs_restore_test';

Object.assign(process.env, {
  POSTGRES_URL: localUrl,
  DATABASE_URL: localUrl,
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

const college = (
  await import('../../src/commands/Economy/college.js')
).default;

const pool = getPaymentPool();

function makeInteraction(guildId, userId, answers) {
  const replies = [];
  let questionIndex = 0;

  return {
    guildId,
    user: { id: userId },
    deferred: false,
    replied: false,
    replies,

    async deferReply() {
      this.deferred = true;
    },

    async reply(payload) {
      replies.push(payload);
      this.replied = true;
      return payload;
    },

    async editReply(payload) {
      replies.push(payload);

      if (!payload.components?.length) {
        return payload;
      }

      const selected = answers[questionIndex++];

      if (!Number.isInteger(selected)) {
        throw new Error('Missing simulated exam answer.');
      }

      const row = payload.components[0];
      const button = row.components[selected];

      if (!button) {
        throw new Error('Simulated answer button not found.');
      }

      const customId = button.toJSON().custom_id;

      return {
        async awaitMessageComponent({ filter }) {
          const clicked = {
            user: { id: userId },
            customId,
            async deferUpdate() {},
          };

          assert.equal(filter(clicked), true);
          return clicked;
        },
      };
    },
  };
}

async function createAccount(guildId, userId) {
  await pool.query(
    `INSERT INTO guilds (id)
     VALUES ($1)
     ON CONFLICT (id) DO NOTHING`,
    [guildId]
  );

  await pool.query(
    `INSERT INTO users (id)
     VALUES ($1)
     ON CONFLICT (id) DO NOTHING`,
    [userId]
  );

  await pool.query(
    `INSERT INTO economy
       (guild_id, user_id, balance, bank, data)
     VALUES (
       $1, $2, 400, 0,
       '{"wallet":400,"bank":0,"level":1,"iq":100}'::jsonb
     )`,
    [guildId, userId]
  );
}

async function getAccount(guildId, userId) {
  const result = await pool.query(
    `SELECT balance, data
     FROM economy
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId]
  );

  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function main() {
  const server = await pool.query(`
    SELECT
      current_database() AS database_name,
      inet_server_addr()::text AS server_address,
      (SELECT MAX(version) FROM schema_migrations)
        AS schema_version
  `);

  const info = server.rows[0];

  if (
    info.database_name !== 'cunvrs_restore_test' ||
    ![
      '127.0.0.1',
      '127.0.0.1/32',
      '::1',
      '::1/128',
    ].includes(info.server_address) ||
    Number(info.schema_version) !== 2
  ) {
    throw new Error(
      'SAFETY STOP: not the approved local v2 database.'
    );
  }

  console.log('PASS: Connected to local test database.');

  const guildId =
    `1888888888${randomInt(100000000, 999999999)}`;

  const graduateId =
    `1777777777${randomInt(100000000, 999999999)}`;

  const failingId =
    `1666666666${randomInt(100000000, 999999999)}`;

  await createAccount(guildId, graduateId);
  await createAccount(guildId, failingId);

  console.log('\n=== GRADUATION TEST ===');

  // Answers: correct, correct, correct.
  const passingExam = makeInteraction(
    guildId,
    graduateId,
    [1, 2, 0]
  );

  await college.execute(passingExam);

  const graduate = await getAccount(guildId, graduateId);

  assert.equal(graduate.data.collegeGraduated, true);
  assert.equal(Number(graduate.data.iq), 100);
  assert.equal(Number(graduate.balance), 400);
  assert.equal(Number(graduate.data.wallet), 400);

  console.log('PASS: College graduation saved.');
  console.log('PASS: Graduate IQ remained 100.');
  console.log('PASS: Graduate wallet remained unchanged.');

  // Graduated students should not be able to retake.
  const secondExam = makeInteraction(
    guildId,
    graduateId,
    []
  );

  await college.execute(secondExam);

  assert.ok(
    secondExam.replies.some(reply =>
      JSON.stringify(reply).includes('already graduated')
    ),
    'Expected already-graduated response.'
  );

  console.log('PASS: Already-graduated student blocked.');

  console.log('\n=== FAILED EXAM TEST ===');

  // Answers: wrong, wrong, wrong.
  const failingExam = makeInteraction(
    guildId,
    failingId,
    [0, 0, 1]
  );

  await college.execute(failingExam);

  const failed = await getAccount(guildId, failingId);

  assert.equal(failed.data.collegeGraduated, false);
  assert.equal(Number(failed.data.iq), 75);
  assert.equal(Number(failed.balance), 400);
  assert.equal(Number(failed.data.wallet), 400);

  console.log('PASS: Failed exam reduced IQ to 75.');
  console.log('PASS: Failed student did not graduate.');
  console.log('PASS: Failed student wallet remained unchanged.');

  const retry = makeInteraction(
    guildId,
    failingId,
    []
  );

  await college.execute(retry);

  assert.ok(
    retry.replies.some(reply =>
      JSON.stringify(reply).includes('100 IQ')
    ),
    'Expected IQ requirement response.'
  );

  console.log('PASS: Retry blocked until 100 IQ.');

  console.log('\nALL COLLEGE TESTS PASSED!');
}

try {
  await main();
} catch (error) {
  console.error('\nTEST FAILED:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
