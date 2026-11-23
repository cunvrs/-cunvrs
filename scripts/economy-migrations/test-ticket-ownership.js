import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';

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
  POSTGRES_SSL: 'false',
  PGHOST: '127.0.0.1',
  PGPORT: '5432',
  PGUSER: 'postgres',
  PGPASSWORD: password,
  PGDATABASE: 'cunvrs_restore_test',
  PGSSLMODE: 'disable',
});

const { getPaymentPool } = await import(
  '../../src/commands/Economy/modules/paymentHandler.js'
);

const {
  verifyTicketOwner,
  getVerifiedTicketOwner,
} = await import(
  '../../src/services/redemptions/ticketOwnership.js'
);

const pool = getPaymentPool();
const id = prefix => prefix + randomInt(100000000, 999999999);

const guildId = id('1888888888');
const channelId = id('1777777777');
const ownerId = id('1666666666');
const staffId = id('1555555555');
const otherId = id('1444444444');

const request = {
  guildId,
  channelId,
  ownerId,
  staffId,
  staffAuthorized: true,
  ownershipConfirmed: true,
};

async function rejected(options, message) {
  await assert.rejects(
    () => verifyTicketOwner({ ...request, ...options }),
    message
  );
}

try {
  const result = await pool.query(`
    SELECT current_database() AS db,
           inet_server_addr()::text AS address,
           (SELECT MAX(version) FROM schema_migrations) AS version
  `);

  assert.equal(result.rows[0].db, 'cunvrs_restore_test');
  assert.ok(
    ['127.0.0.1', '127.0.0.1/32'].includes(result.rows[0].address)
  );
  assert.equal(Number(result.rows[0].version), 2);

  console.log('PASS: Approved local test database.');

  await rejected(
    { staffAuthorized: false },
    /Manage Server/
  );

  console.log('PASS: Unauthorized verification blocked.');

  await rejected(
    { ownershipConfirmed: false },
    /ownership must be confirmed/
  );

  console.log('PASS: Unconfirmed ownership blocked.');

  await rejected(
    { ownerId: staffId },
    /self-verify/
  );

  console.log('PASS: Staff self-verification blocked.');

  const first = await verifyTicketOwner(request);

  assert.equal(first.verified, true);
  assert.equal(first.alreadyVerified, false);

  console.log('PASS: Ticket ownership saved.');

  const saved = await getVerifiedTicketOwner(
    guildId,
    channelId
  );

  assert.equal(saved.owner_id, ownerId);
  assert.equal(saved.verified_by, staffId);

  console.log('PASS: Verified owner retrieved.');

  const repeat = await verifyTicketOwner(request);

  assert.equal(repeat.alreadyVerified, true);

  console.log('PASS: Repeated verification recognized.');

  await rejected(
    { ownerId: otherId },
    /different owner/
  );

  console.log('PASS: Ownership reassignment blocked.');

  const unchanged = await getVerifiedTicketOwner(
    guildId,
    channelId
  );

  assert.equal(unchanged.owner_id, ownerId);

  console.log('PASS: Original owner preserved.');
  console.log('\nALL TICKET OWNERSHIP TESTS PASSED!');
} catch (error) {
  console.error('\nOWNERSHIP TEST FAILED:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
