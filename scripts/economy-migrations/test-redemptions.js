import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';

const password = process.env.CUNVRS_LOCAL_DB_PASSWORD;
if (!password) throw new Error('Missing local database password.');

const url = new URL('postgresql://127.0.0.1:5432/cunvrs_restore_test');
url.username = 'postgres';
url.password = password;

Object.assign(process.env, {
  POSTGRES_URL: url.toString(),
  DATABASE_URL: url.toString(),
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
const {
  requestRedemption,
  transitionRedemption,
  getRedemption
} = await import(
  '../../src/services/redemptions/redemptionService.js'
);

const pool = getPaymentPool();
const id = prefix => prefix + randomInt(100000000, 999999999);

const guildId = id('1888888888');
const userId = id('1777777777');
const staffId = id('1666666666');
const channelId = id('1555555555');
const otherChannel = id('1444444444');

const request = (interactionId, itemCode = 'ugc_reward') => ({
  guildId, channelId, userId, interactionId, itemCode
});

const transition = (redemptionId, action) => ({
  guildId, channelId, redemptionId, staffId,
  staffAuthorized: true, action
});

async function balance() {
  const result = await pool.query(
    'SELECT balance,data FROM economy WHERE guild_id=$1 AND user_id=$2',
    [guildId, userId]
  );
  assert.equal(Number(result.rows[0].balance),
    Number(result.rows[0].data.wallet));
  return Number(result.rows[0].balance);
}

try {
  const check = (await pool.query(`
    SELECT current_database() AS db,
      inet_server_addr()::text AS address,
      (SELECT MAX(version) FROM schema_migrations) AS version
  `)).rows[0];

  assert.equal(check.db, 'cunvrs_restore_test');
  assert.ok(['127.0.0.1','127.0.0.1/32'].includes(check.address));
  assert.equal(Number(check.version), 2);
  console.log('PASS: Local test database verified.');

  await pool.query(
    'INSERT INTO guilds(id) VALUES ($1) ON CONFLICT DO NOTHING',
    [guildId]
  );
  for (const id of [userId,staffId]) {
    await pool.query(
      'INSERT INTO users(id) VALUES ($1) ON CONFLICT DO NOTHING',
      [id]
    );
  }

  await pool.query(
    `INSERT INTO economy(guild_id,user_id,balance,bank,data)
     VALUES ($1,$2,50000,0,$3::jsonb)`,
    [guildId,userId,JSON.stringify({wallet:50000,bank:0,level:1})]
  );

  await pool.query(
    `INSERT INTO cunvrs_ticketcord_owners
       (guild_id, channel_id, owner_id, verified_by, verification_method)
     VALUES ($1, $2, $3, $4, 'cunvrs_native_created')`,
    [guildId, channelId, userId, staffId]
  );

  console.log('PASS: Test ticket owner verified.');

  const unverified = await requestRedemption({
    ...request(id('1333333333')),
    channelId:otherChannel
  });
  assert.equal(unverified.success,false);
  assert.equal(await balance(),50000);
  console.log('PASS: Unverified ticket cannot spend Unicoins.');

  const disabled = await requestRedemption(
    request(id('1333333333'),'robux_50')
  );
  assert.equal(disabled.success,false);
  assert.equal(await balance(),50000);
  console.log('PASS: Disabled Robux reward cannot be purchased.');

  const firstId = id('1333333333');
  const first = await requestRedemption(request(firstId));
  assert.equal(first.success,true);
  assert.equal(first.reserved,12000);
  assert.equal(await balance(),38000);
  console.log('PASS: UGC redemption reserves 12,000 Unicoins.');

  const duplicate = await requestRedemption(request(firstId));
  assert.equal(duplicate.success,false);
  assert.equal(await balance(),38000);
  console.log('PASS: Duplicate request cannot charge twice.');

  const pending = await requestRedemption(request(id('1333333333')));
  assert.equal(pending.success,false);
  console.log('PASS: Second pending redemption blocked.');

  const unauthorized = transition(
    first.redemptionId,'approve'
  );
  unauthorized.staffAuthorized=false;

  await assert.rejects(
    () => transitionRedemption(unauthorized),
    /Manage Server/
  );
  console.log('PASS: Unauthorized staff action blocked.');

  const declined = await transitionRedemption(
    transition(first.redemptionId,'decline')
  );
  assert.equal(declined.success,true);
  assert.equal(await balance(),50000);

  const refundAgain = await transitionRedemption(
    transition(first.redemptionId,'decline')
  );
  assert.equal(refundAgain.success,false);
  assert.equal(await balance(),50000);
  console.log('PASS: Decline refunds exactly once.');

  const second = await requestRedemption(
    request(id('1333333333'),'vip_30d')
  );
  assert.equal(second.success,true);
  assert.equal(await balance(),30000);

  const approved = await transitionRedemption(
    transition(second.redemptionId,'approve')
  );
  assert.equal(approved.status,'approved');

  await assert.rejects(
    () => transitionRedemption(
      transition(second.redemptionId,'deliver')
    ),
    /fulfillment reference/
  );
  assert.equal(await balance(),30000);
  console.log('PASS: Delivery without evidence rejected.');

  const delivered = await transitionRedemption(
    {
      ...transition(second.redemptionId,'deliver'),
      fulfillmentEvidence: 'TEST_FULFILLMENT_REFERENCE_12345'
    }
  );
  assert.equal(delivered.status,'delivered');

  const lateDecline = await transitionRedemption(
    transition(second.redemptionId,'decline')
  );
  assert.equal(lateDecline.success,false);
  assert.equal(await balance(),30000);

  const saved = await getRedemption(guildId,second.redemptionId);
  assert.equal(saved.status,'delivered');

  const deliveryRecord = saved.details.history.find(
    entry => entry.action === 'deliver'
  );

  assert.ok(deliveryRecord);
  assert.equal(
    deliveryRecord.fulfillmentEvidence,
    'TEST_FULFILLMENT_REFERENCE_12345'
  );

  console.log('PASS: Fulfillment evidence persisted in PostgreSQL.');
  console.log('PASS: Approval and delivery recorded.');
  console.log('PASS: Delivered reward cannot be refunded.');

  const ledger = await pool.query(
    `SELECT event_type,amount FROM cunvrs_economy_ledger
     WHERE guild_id=$1 AND user_id=$2
     AND event_type IN ('redemption_hold','redemption_refund')`,
    [guildId,userId]
  );

  assert.equal(
    ledger.rows.filter(r => r.event_type==='redemption_hold').length,2
  );
  assert.equal(
    ledger.rows.filter(r => r.event_type==='redemption_refund').length,1
  );
  assert.equal(
    ledger.rows.reduce((sum,r)=>sum+Number(r.amount),0),-20000
  );
  console.log('PASS: All holds and refunds accounted for.');
  console.log('\nALL REDEMPTION TESTS PASSED!');
} catch (error) {
  console.error('\nREDEMPTION TEST FAILED:',error);
  process.exitCode=1;
} finally {
  await pool.end();
}
