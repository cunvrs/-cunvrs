import fs from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';

const mode = process.argv[2] ?? 'status';
const confirm = process.argv[3];

if (!['status', 'apply'].includes(mode)) {
  throw new Error('Use status or apply.');
}

if (mode === 'apply' && confirm !== '--confirm-local') {
  throw new Error('Local application requires --confirm-local.');
}

const base = new URL('./', import.meta.url);
const migrations = [
  [3, '003_native_redemption_closures.sql'],
  [4, '004_native_redemption_deleting_state.sql'],
  [5, '005_unicoin_shop_redemptions.sql']
];

const ledger = 'cunvrs_economy_migrations';

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
let active = false;

async function tableExists(name) {
  const result = await db.query(
    'SELECT to_regclass($1)::text AS name',
    [`public.${name}`]
  );
  return Boolean(result.rows[0].name);
}

async function closingStructureValid() {
  if (!await tableExists(
    'cunvrs_native_redemption_closures'
  )) return false;

  const result = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='cunvrs_native_redemption_closures'
  `);

  const columns = new Set(
    result.rows.map(row => row.column_name)
  );

  const required = [
    'guild_id', 'channel_id', 'owner_id',
    'state', 'started_by', 'archive_message_id',
    'started_at', 'updated_at'
  ];

  if (!required.every(column => columns.has(column))) {
    return false;
  }

  const keys = await db.query(`
    SELECT contype
    FROM pg_constraint
    WHERE conrelid =
      'public.cunvrs_native_redemption_closures'::regclass
      AND contype IN ('p', 'f')
  `);

  const types = keys.rows.map(row => row.contype);
  return types.includes('p') && types.includes('f');
}

async function hasDeletingState() {
  if (!await closingStructureValid()) return false;

  const result = await db.query(`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid =
      'public.cunvrs_native_redemption_closures'::regclass
      AND conname =
        'cunvrs_native_redemption_closures_state_check'
  `);

  if (result.rows.length !== 1) return false;

  const definition = result.rows[0].definition;

  return [
    'closing', 'archived', 'deleting', 'closed'
  ].every(state => definition.includes(`'${state}'`));
}

async function recordedMigrations() {
  if (!await tableExists(ledger)) return new Map();

  const result = await db.query(`
    SELECT version, filename, checksum
    FROM cunvrs_economy_migrations
    ORDER BY version
  `);

  return new Map(
    result.rows.map(row => [Number(row.version), row])
  );
}

async function allowsUnicoinOnlyRedemptions() {
  const { rows } = await db.query(`
    SELECT is_nullable
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='cunvrs_redemptions'
      AND column_name='ticket_type'
  `);
  return rows[0]?.is_nullable === 'YES';
}

const schemaChecks = {
  3: closingStructureValid,
  4: hasDeletingState,
  5: allowsUnicoinOnlyRedemptions
};

function migrationSource(filename) {
  const content = fs.readFileSync(
    new URL(filename, base),
    'utf8'
  );

  const checksum = createHash('sha256')
    .update(content)
    .digest('hex');

  // The runner owns the transaction. Remove the
  // standalone SQL file's transaction statements.
  const sql = content
    .replace(/^\s*BEGIN\s*;\s*$/gim, '')
    .replace(/^\s*COMMIT\s*;\s*$/gim, '');

  if (/\bBEGIN\s*;|\bCOMMIT\s*;/i.test(sql)) {
    throw new Error(
      'Unexpected transaction command in ' + filename
    );
  }

  return { filename, checksum, sql };
}

try {
  await db.query(
    mode === 'status' ? 'BEGIN READ ONLY' : 'BEGIN'
  );
  active = true;

  const identity = await db.query(`
    SELECT current_database() AS name,
           inet_server_addr()::text AS address
  `);

  if (
    identity.rows[0].name !== 'cunvrs_restore_test' ||
    !/^(127\.0\.0\.1(?:\/32)?|::1(?:\/128)?)$/
      .test(identity.rows[0].address ?? '')
  ) {
    throw new Error('Refusing nonlocal or incorrect database.');
  }

  console.log('PASS: Isolated local database verified.');

  const baseline = await db.query(`
    SELECT MAX(version)::integer AS version
    FROM schema_migrations
  `);

  if (baseline.rows[0].version !== 2) {
    throw new Error(
      'Baseline ledger differs from expected version 2.'
    );
  }

  console.log('PASS: Original schema ledger remains version 2.');

  const sources = migrations.map(([version, filename]) => ({
    version,
    ...migrationSource(filename)
  }));

  if (mode === 'apply') {
    await db.query(
      'SELECT pg_advisory_xact_lock(19431, 44004)'
    );

    await db.query(`
      CREATE TABLE IF NOT EXISTS cunvrs_economy_migrations (
        version INTEGER PRIMARY KEY,
        filename TEXT NOT NULL,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  const recorded = await recordedMigrations();

  for (const source of sources) {
    const existing = recorded.get(source.version);

    if (existing) {
      if (
        existing.filename !== source.filename ||
        existing.checksum !== source.checksum
      ) {
        throw new Error(
          'Migration checksum mismatch: ' + source.filename
        );
      }

      console.log(
        'TRACKED: ' + source.filename
      );
      continue;
    }

    const checkSchema = schemaChecks[source.version];
    const alreadyApplied = await checkSchema();

    if (mode === 'status') {
      console.log(
        (alreadyApplied ? 'UNTRACKED / PRESENT: ' : 'PENDING: ') +
        source.filename
      );
      continue;
    }

    if (!alreadyApplied) {
      if (source.version === 3 &&
          await tableExists(
            'cunvrs_native_redemption_closures'
          )) {
        throw new Error(
          'Existing closing table has unexpected structure.'
        );
      }

      if (source.version === 4 && !await closingStructureValid()) {
        throw new Error(
          'Closing table prerequisites missing.'
        );
      }

      await db.query(source.sql);

      console.log('APPLIED: ' + source.filename);
    } else {
      console.log(
        'ADOPTED EXISTING SCHEMA: ' + source.filename
      );
    }

    if (!await checkSchema()) {
      throw new Error(
        'Post-migration verification failed: ' +
        source.filename
      );
    }

    await db.query(
      `INSERT INTO cunvrs_economy_migrations
         (version, filename, checksum)
       VALUES ($1, $2, $3)`,
      [
        source.version,
        source.filename,
        source.checksum
      ]
    );
  }

  if (mode === 'apply' && !await hasDeletingState()) {
    throw new Error('Final deleting-state verification failed.');
  }

  if (mode === 'status') {
    await db.query('ROLLBACK');
    console.log('\nPASS: Read-only migration status complete.');
  } else {
    await db.query('COMMIT');
    console.log('\nPASS: Local economy migrations recorded.');
  }

  active = false;

} catch (error) {
  if (active) {
    await db.query('ROLLBACK').catch(() => {});
  }

  throw error;

} finally {
  db.release();
  await pool.end();
}
