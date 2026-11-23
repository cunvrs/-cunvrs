import fs from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';

const mode = process.argv[2] ?? 'status';
const confirmation = process.argv[3];

assert.ok(
  ['status', 'apply'].includes(mode),
  'Only status and apply modes are supported.'
);

if (mode === 'apply') {
  assert.equal(
    confirmation,
    '--confirm-local',
    'Applying requires --confirm-local.'
  );
}

assert.ok(
  process.env.CUNVRS_LOCAL_DB_PASSWORD,
  'Local PostgreSQL password required.'
);

const files = [
  [1, '001_economy_foundation.sql'],
  [2, '002_native_redemption_claims.sql'],
  [3, '003_native_redemption_closures.sql'],
  [4, '004_native_redemption_deleting_state.sql'],
  [5, '005_unicoin_shop_redemptions.sql']
];

const specifications = {
  cunvrs_economy_ledger: {
    columns: [
      'id', 'operation_id', 'guild_id', 'user_id',
      'event_type', 'amount', 'balance_before',
      'balance_after', 'details'
    ],
    fk: 2,
    checks: 3,
    indexes: [
      'idx_cunvrs_ledger_user_time',
      'idx_cunvrs_ledger_type_time'
    ]
  },
  cunvrs_economy_daily_limits: {
    columns: [
      'guild_id', 'user_id', 'local_day',
      'repeatable_coins', 'minigame_coins'
    ],
    fk: 2,
    checks: 4
  },
  cunvrs_redemption_ticket_balances: {
    columns: [
      'guild_id', 'user_id', 'ticket_type',
      'available', 'reserved'
    ],
    fk: 2,
    checks: 3
  },
  cunvrs_ticketcord_owners: {
    columns: [
      'guild_id', 'channel_id', 'owner_id',
      'verified_by', 'verification_method'
    ],
    fk: 2,
    checks: 0
  },
  cunvrs_redemptions: {
    columns: [
      'id', 'guild_id', 'user_id', 'channel_id',
      'item_code', 'ticket_type',
      'coins_reserved', 'status', 'details'
    ],
    fk: 2,
    checks: 2,
    indexes: [
      'uq_cunvrs_one_pending_redemption',
      'idx_cunvrs_redemptions_user'
    ]
  },
  cunvrs_native_redemption_claims: {
    columns: ['channel_id', 'claimed_by', 'claimed_at'],
    fk: 1,
    checks: 0
  }
};

function metadata(version, filename) {
  const file = new URL(filename, import.meta.url);
  const source = fs.readFileSync(file);

  return {
    version,
    filename,
    checksum: createHash('sha256')
      .update(source)
      .digest('hex')
  };
}

const migrations = files.map(([version, filename]) =>
  metadata(version, filename)
);

const pool = new pg.Pool({
  host: '127.0.0.1',
  port: 5432,
  database: 'cunvrs_restore_test',
  user: 'postgres',
  password: process.env.CUNVRS_LOCAL_DB_PASSWORD,
  ssl: false,
  max: 1,
  connectionTimeoutMillis: 5000
});

const db = await pool.connect();
let transaction = false;

async function checkTable(name, spec) {
  const columns = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name=$1
  `, [name]);

  const found = new Set(
    columns.rows.map(row => row.column_name)
  );

  for (const column of spec.columns) {
    assert.ok(
      found.has(column),
      `${name}: missing column ${column}`
    );
  }

  const constraints = await db.query(`
    SELECT contype AS type,
           pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid=to_regclass($1)
  `, [`public.${name}`]);

  const rows = constraints.rows;

  assert.equal(
    rows.filter(row => row.type === 'p').length,
    1,
    `${name}: primary key mismatch`
  );

  assert.equal(
    rows.filter(row => row.type === 'f').length,
    spec.fk,
    `${name}: foreign key mismatch`
  );

  assert.ok(
    rows.filter(row => row.type === 'c').length >= spec.checks,
    `${name}: CHECK constraint mismatch`
  );

  const indexes = await db.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname='public'
      AND tablename=$1
  `, [name]);

  for (const index of spec.indexes ?? []) {
    assert.ok(
      indexes.rows.some(row => row.indexname === index),
      `${name}: missing index ${index}`
    );
  }

  if (name === 'cunvrs_economy_ledger') {
    assert.ok(
      rows.some(row =>
        row.type === 'u' &&
        /operation_id/.test(row.definition)
      ),
      'Ledger operation_id uniqueness not verified.'
    );
  }

  if (name === 'cunvrs_redemptions') {
    assert.ok(
      indexes.rows.some(row =>
        row.indexname === 'uq_cunvrs_one_pending_redemption' &&
        /UNIQUE/i.test(row.indexdef) &&
        /pending_approval/.test(row.indexdef)
      ),
      'Pending redemption uniqueness not verified.'
    );
  }

  if (name === 'cunvrs_native_redemption_claims') {
    assert.ok(
      rows.some(row =>
        row.type === 'f' &&
        /cunvrs_ticketcord_owners/.test(row.definition) &&
        /ON DELETE CASCADE/.test(row.definition)
      ),
      'Native claim ownership cascade not verified.'
    );
  }

  console.log('VERIFIED:', name);
}

try {
  await db.query(
    mode === 'status' ? 'BEGIN READ ONLY' : 'BEGIN'
  );
  transaction = true;

  const identity = await db.query(`
    SELECT current_database() AS name,
           inet_server_addr()::text AS address,
           inet_server_port() AS port
  `);

  const actual = identity.rows[0];

  assert.equal(actual.name, 'cunvrs_restore_test');
  assert.match(
    actual.address ?? '',
    /^(127\.0\.0\.1|::1)(\/32|\/128)?$/
  );
  assert.equal(Number(actual.port), 5432);

  console.log('PASS: Isolated local database verified.');

  if (mode === 'apply') {
    await db.query(
      'SELECT pg_advisory_xact_lock(19431, 44004)'
    );
  }

  const baseline = await db.query(`
    SELECT MAX(version)::integer AS version
    FROM schema_migrations
  `);

  assert.equal(
    baseline.rows[0].version,
    2,
    'Unexpected baseline schema version.'
  );

  for (const [name, spec] of Object.entries(specifications)) {
    await checkTable(name, spec);
  }

  const closure = await db.query(`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid =
      'public.cunvrs_native_redemption_closures'::regclass
      AND conname =
        'cunvrs_native_redemption_closures_state_check'
  `);

  assert.equal(closure.rows.length, 1);

  for (const state of [
    'closing', 'archived', 'deleting', 'closed'
  ]) {
    assert.ok(
      closure.rows[0].definition.includes(state),
      `Closure state missing: ${state}`
    );
  }

  const ledger = await db.query(`
    SELECT version, filename, checksum
    FROM cunvrs_economy_migrations
    ORDER BY version
  `);

  const recorded = new Map(
    ledger.rows.map(row => [Number(row.version), row])
  );

  // Migrations 003 and 004 are required, and 005 is checked when tracked.
  // This script never applies or changes them.
  for (const source of migrations.slice(2)) {
    const row = recorded.get(source.version);
    if (!row && source.version === 5) continue;

    assert.ok(
      row,
      `Migration ${source.version} must already be tracked.`
    );

    assert.equal(row.filename, source.filename);
    assert.equal(row.checksum, source.checksum);
  }

  // Refuse unexpected migration records.
  for (const version of recorded.keys()) {
    assert.ok(
      migrations.some(item => item.version === version),
      `Unexpected migration version: ${version}`
    );
  }

  for (const source of migrations.slice(0, 2)) {
    const row = recorded.get(source.version);

    if (row) {
      assert.equal(row.filename, source.filename);
      assert.equal(row.checksum, source.checksum);

      console.log('TRACKED:', source.filename);
      continue;
    }

    if (mode === 'status') {
      console.log(
        'VERIFIED BUT UNTRACKED:',
        source.filename
      );
      continue;
    }

    // Adoption records existing verified structures only.
    // No numbered SQL migration is executed.
    await db.query(`
      INSERT INTO cunvrs_economy_migrations
        (version, filename, checksum)
      VALUES ($1, $2, $3)
    `, [
      source.version,
      source.filename,
      source.checksum
    ]);

    console.log('ADOPTED:', source.filename);
  }

  for (const source of migrations.slice(2)) {
    if (recorded.has(source.version)) console.log('TRACKED:', source.filename);
  }

  if (mode === 'status') {
    await db.query('ROLLBACK');
    console.log('\nPASS: Read-only adoption preflight.');
  } else {
    await db.query('COMMIT');
    console.log('\nPASS: Local foundation ledger updated.');
  }

  transaction = false;

} catch (error) {
  if (transaction) {
    await db.query('ROLLBACK').catch(() => {});
  }
  throw error;
} finally {
  db.release();
  await pool.end();
}
