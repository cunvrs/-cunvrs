import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';

const password = process.env.CUNVRS_LOCAL_DB_PASSWORD;
if (!password) throw new Error('Missing local PostgreSQL password.');

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
  PGSSLMODE: 'disable'
});

const { getPaymentPool } = await import(
  '../../src/commands/Economy/modules/paymentHandler.js'
);
const { getQuestStatus, claimQuest } = await import(
  '../../src/commands/Economy/modules/questService.js'
);

const pool = getPaymentPool();
const id = prefix => prefix + randomInt(100000000, 999999999);
const guild = id('1888888888');
const user = id('1777777777');

try {
  const { rows } = await pool.query(
    `SELECT current_database() AS db,
            inet_server_addr()::text AS address,
            (SELECT MAX(version) FROM schema_migrations) AS version`
  );

  assert.equal(rows[0].db, 'cunvrs_restore_test');
  assert.ok(['127.0.0.1', '127.0.0.1/32'].includes(rows[0].address));
  assert.equal(Number(rows[0].version), 2);
  console.log('PASS: Local test database verified.');

  const incomplete = await claimQuest(guild, user, 'work');
  assert.equal(incomplete.success, false);
  console.log('PASS: Incomplete quest blocked.');

  // Create the fake test guild and user before inserting quest progress.
  await pool.query(
    'INSERT INTO guilds (id) VALUES ($1) ON CONFLICT DO NOTHING',
    [guild]
  );

  await pool.query(
    'INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING',
    [user]
  );

  const day = (await pool.query(
    `SELECT (NOW() AT TIME ZONE 'America/Detroit')::date::text AS day`
  )).rows[0].day;

  await pool.query(
    'INSERT INTO cunvrs_economy_daily_limits (guild_id,user_id,local_day,work_shifts,repeatable_coins,minigame_coins) VALUES ($1,$2,$3::date,2,500,300)',
    [guild,user,day]
  );

  await pool.query(
    `INSERT INTO economy
       (guild_id, user_id, balance, bank, data)
     VALUES ($1, $2, 500, 0, $3::jsonb)
     ON CONFLICT (guild_id, user_id)
     DO UPDATE SET
       balance = 500,
       data = jsonb_set(
         economy.data,
         '{wallet}',
         '500'::jsonb
       )`,
    [
      guild,
      user,
      JSON.stringify({
        wallet: 500,
        bank: 0,
        level: 1
      })
    ]
  );

  const events = [
    ['minigame_trivia',100,0,100],
    ['minigame_trivia',100,100,200],
    ['minigame_trivia',100,200,300],
    ['work_reward',200,300,500]
  ];

  for (const [type,amount,before,after] of events) {
    await pool.query(
      `INSERT INTO cunvrs_economy_ledger
       (operation_id,guild_id,user_id,actor_id,event_type,amount,balance_before,balance_after)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7)`,
      [randomUUID(),guild,user,type,amount,before,after]
    );
  }

  const status = await getQuestStatus(guild,user);
  assert.ok(status.quests.every(q => q.completed && !q.claimed));
  console.log('PASS: All three quest goals detected.');

  for (const [quest,reward] of [['work',150],['games',200],['coins',250]]) {
    const result = await claimQuest(guild,user,quest);
    assert.equal(result.success,true);
    assert.equal(result.earned,reward);
    console.log(`PASS: ${quest} quest awarded ${reward} Unicoins.`);
  }

  const duplicates = await Promise.all([
    claimQuest(guild,user,'work'),
    claimQuest(guild,user,'work')
  ]);
  assert.ok(duplicates.every(r => !r.success));
  console.log('PASS: Duplicate claims blocked.');

  const account = (await pool.query(
    'SELECT balance,data FROM economy WHERE guild_id=$1 AND user_id=$2',
    [guild,user]
  )).rows[0];

  assert.equal(Number(account.balance),1100);
  assert.equal(Number(account.data.wallet),1100);
  console.log('PASS: Final wallet balance is 1,100.');

  const rewards = (await pool.query(
    `SELECT amount FROM cunvrs_economy_ledger
     WHERE guild_id=$1 AND user_id=$2 AND event_type='quest_reward'`,
    [guild,user]
  )).rows;

  assert.equal(rewards.length,3);
  assert.equal(rewards.reduce((a,r) => a+Number(r.amount),0),600);
  console.log('PASS: Exactly 600 quest Unicoins recorded.');

  console.log('\nALL QUEST TESTS PASSED!');
} catch (error) {
  console.error('\nQUEST TEST FAILED:',error);
  process.exitCode=1;
} finally {
  await pool.end();
}
