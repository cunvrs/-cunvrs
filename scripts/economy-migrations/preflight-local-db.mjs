// Read-only preflight for the cunvrs. Economy 2.0 local PostgreSQL test environment.
// Intentionally does not create a database, mutate records, or load production .env.
// Usage (PowerShell): $env:CUNVRS_TEST_DB="cunvrs_economy_v2_disposable"; node scripts/economy-migrations/preflight-local-db.mjs
import pg from 'pg';

const expectedName = 'cunvrs_economy_v2_disposable';
const selectedName = process.env.CUNVRS_TEST_DB;
const password = process.env.CUNVRS_LOCAL_DB_PASSWORD;

function fail(message) {
  console.error('BLOCKED:', message);
  process.exitCode = 1;
}

if (selectedName !== expectedName) {
  fail(`Set CUNVRS_TEST_DB to ${expectedName}; restored or production databases are not safe for write tests.`);
} else if (!password) {
  fail('Set CUNVRS_LOCAL_DB_PASSWORD in this PowerShell session (never paste it into chat).');
} else {
  const pool = new pg.Pool({
    host: '127.0.0.1',
    port: 5432,
    database: selectedName,
    user: 'postgres',
    password,
    ssl: false,
    connectionTimeoutMillis: 5000,
    max: 1,
  });

  try {
    // PostgreSQL inet values may stringify as 127.0.0.1/32.
    // host(...) strips the network mask for an exact comparison.
    const { rows: [identity] } = await pool.query(`
      SELECT current_database() AS db,
             host(inet_server_addr()) AS server_host,
             inet_server_port() AS server_port,
             pg_is_in_recovery() AS replica
    `);

    if (identity.db !== expectedName ||
        identity.server_host !== '127.0.0.1' ||
        identity.server_port !== 5432 ||
        identity.replica) {
      throw new Error('Unexpected database identity, address, port, or replica state.');
    }

    const { rows: [tables] } = await pool.query(`
      SELECT to_regclass('public.economy') IS NOT NULL AS has_economy,
             to_regclass('public.cunvrs_economy_ledger') IS NOT NULL AS has_ledger,
             to_regclass('public.cunvrs_redemptions') IS NOT NULL AS has_redemptions,
             to_regclass('public.schema_migrations') IS NOT NULL AS has_schema
    `);

    if (!Object.values(tables).every(Boolean)) {
      throw new Error('Required Economy 2.0 tables are missing; initialize the disposable database separately.');
    }

    const { rows: [counts] } = await pool.query(`
      SELECT (SELECT COUNT(*) FROM economy) AS wallets,
             (SELECT COUNT(*) FROM cunvrs_economy_ledger) AS ledger,
             (SELECT COUNT(*) FROM cunvrs_redemptions) AS redemptions,
             (SELECT MAX(version) FROM schema_migrations) AS schema_version
    `);

    console.log('Database:', identity.db);
    console.log('Server:', identity.server_host + ':' + identity.server_port);
    console.log('Schema version:', counts.schema_version);
    console.log('Wallet rows:', counts.wallets);
    console.log('Ledger rows:', counts.ledger);
    console.log('Redemption rows:', counts.redemptions);

    if (Number(counts.schema_version) !== 2) {
      throw new Error('Expected schema version 2.');
    }
    if ([counts.wallets, counts.ledger, counts.redemptions].some(n => Number(n) !== 0)) {
      throw new Error('Database contains existing economy/redemption data; do not run mutation tests.');
    }
    console.log('PASS: Disposable local database preflight (read-only).');
    console.log('NOTE: Existing test scripts still hardcode cunvrs_restore_test; update their connection handling before running them.');
  } catch (error) {
    fail(error.message);
  } finally {
    await pool.end();
  }
}
