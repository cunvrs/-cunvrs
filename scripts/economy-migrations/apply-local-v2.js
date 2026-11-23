
/**
 * cunvrs economy foundation: LOCAL RESTORED DATABASE ONLY.
 * Does not use POSTGRES_URL, DATABASE_URL, or .env.
 * Requires a local PostgreSQL password when eventually executed.
 */

import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const EXPECTED_DATABASE = 'cunvrs_restore_test';

const EXPECTED_TABLES = [
  'cunvrs_economy_daily_limits',
  'cunvrs_economy_ledger',
  'cunvrs_redemption_ticket_balances',
  'cunvrs_redemptions',
  'cunvrs_ticketcord_owners',
];

const password = process.env.CUNVRS_LOCAL_DB_PASSWORD;

if (!password) {
  console.error(
    'Missing CUNVRS_LOCAL_DB_PASSWORD. Set your LOCAL PostgreSQL password before running.'
  );
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({
    host: '127.0.0.1',
    port: 5432,
    database: EXPECTED_DATABASE,
    user: 'postgres',
    password,
    ssl: false,
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  let client;
  let inTransaction = false;

  try {
    client = await pool.connect();

    const target = await client.query(
      'SELECT current_database() AS db, inet_server_addr()::text AS addr'
    );

    const { db, addr } = target.rows[0];

    if (
      db !== EXPECTED_DATABASE ||
     !['127.0.0.1', '127.0.0.1/32', '::1', '::1/128'].includes(addr)
    ) {
      throw new Error(
        `Wrong database target: ${db} at ${addr}. No changes made.`
      );
    }

    await client.query('BEGIN');
    inTransaction = true;

    await client.query(
      'SELECT pg_advisory_xact_lock($1)',
      [747201]
    );

    const versions = await client.query(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
    );

    const current = versions.rows.length
      ? Number(versions.rows[0].version)
      : null;

    if (current !== 1 && current !== 2) {
      throw new Error(
        `Expected schema version 1 or 2, found ${current}.`
      );
    }

    const balanceQuery = `
      SELECT COUNT(*)::bigint AS accounts,
             COALESCE(SUM(balance), 0)::bigint AS wallet,
             COALESCE(SUM(bank), 0)::bigint AS bank
      FROM economy
    `;

    const before = await client.query(balanceQuery);

    if (current === 1) {
      const sqlPath = fileURLToPath(
        new URL('./001_economy_foundation.sql', import.meta.url)
      );

      const rawSql = await readFile(sqlPath, 'utf8');

      // The SQL file already contains BEGIN and COMMIT.
      // Remove those boundaries so everything uses one transaction.
      const sql = rawSql
        .replace(/^\s*BEGIN\s*;\s*/im, '\n')
        .replace(/\s*COMMIT\s*;\s*$/im, '\n');

      if (
        sql === rawSql ||
        /(?:^|\n)\s*(?:BEGIN|COMMIT)\s*;/im.test(sql)
      ) {
        throw new Error(
          'Cannot safely isolate SQL transaction boundaries.'
        );
      }

      await client.query(sql);
    }

    const found = await client.query(
      `SELECT tablename
       FROM pg_tables
       WHERE schemaname = 'public'
       AND tablename = ANY($1::text[])`,
      [EXPECTED_TABLES]
    );

    const names = new Set(
      found.rows.map(row => row.tablename)
    );

    const missing = EXPECTED_TABLES.filter(
      name => !names.has(name)
    );

    if (missing.length) {
      throw new Error(
        `Missing foundation tables: ${missing.join(', ')}`
      );
    }

    const after = await client.query(balanceQuery);

    for (const field of ['accounts', 'wallet', 'bank']) {
      if (before.rows[0][field] !== after.rows[0][field]) {
        throw new Error(
          `Balance check failed for ${field}.`
        );
      }
    }

    if (current === 1) {
      await client.query(
        `INSERT INTO schema_migrations (version, label)
         VALUES ($1, $2)`,
        [2, 'cunvrs-economy-foundation-v2']
      );
    }

    await client.query('COMMIT');
    inTransaction = false;

    console.log(
      current === 1
        ? 'Local v2 migration committed successfully!'
        : 'Local v2 already recorded and verified!'
    );

    console.log(
      `Foundation tables verified: ${EXPECTED_TABLES.length}`
    );

    console.log(
      `Accounts: ${after.rows[0].accounts}; ` +
      `Wallet: ${after.rows[0].wallet}; ` +
      `Bank: ${after.rows[0].bank}`
    );

    console.log(
      'Database: cunvrs_restore_test (localhost only).'
    );
  } catch (error) {
    if (inTransaction && client) {
      await client.query('ROLLBACK').catch(() => {});
    }

    console.error(
      `Local migration stopped: ${error.message}`
    );

    process.exitCode = 1;
  } finally {
    client?.release();
    await pool.end();
  }
}
