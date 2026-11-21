
import { randomUUID } from 'node:crypto';

export const UNICOIN_EMOJI = '<:unicoin:1573337526716997773>';

export function formatUnicoins(amount) {
  return `${UNICOIN_EMOJI} ${Number(amount).toLocaleString('en-US')}`;
}

function checkId(value, name) {
  if (typeof value !== 'string' || !/^\d{15,22}$/.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function checkAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('Unicoin amount must be a positive safe integer.');
  }
  return amount;
}

function checkOperationId(value) {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error('A valid operation UUID is required.');
  }
  return value;
}


function walletFromRow(row) {
  const data = row.data || {};

  const balance = Number(row.balance);
  const storedWallet = Number(data.wallet ?? row.balance);

  if (
    !Number.isSafeInteger(balance) ||
    balance < 0 ||
    !Number.isSafeInteger(storedWallet) ||
    storedWallet < 0
  ) {
    throw new Error('Invalid existing wallet balance.');
  }

  if (balance !== storedWallet) {
    throw new Error(
      'Wallet consistency error: database balance and wallet data do not match.'
    );
  }

  return { balance, data };
}

async function ensureAccount(db, guildId, userId) {
  await db.query(
    `INSERT INTO guilds (id, created_at)
     VALUES ($1, CURRENT_TIMESTAMP)
     ON CONFLICT (id) DO NOTHING`,
    [guildId]
  );

  await db.query(
    `INSERT INTO users (id, created_at)
     VALUES ($1, CURRENT_TIMESTAMP)
     ON CONFLICT (id) DO NOTHING`,
    [userId]
  );

  await db.query(
    `INSERT INTO economy
       (guild_id, user_id, balance, bank, data)
     VALUES ($1, $2, 0, 0, '{"wallet":0,"bank":0}'::jsonb)
     ON CONFLICT (guild_id, user_id) DO NOTHING`,
    [guildId, userId]
  );
}

async function lockedWallet(db, guildId, userId) {
  const result = await db.query(
    `SELECT balance, data
     FROM economy
     WHERE guild_id = $1 AND user_id = $2
     FOR UPDATE`,
    [guildId, userId]
  );

  if (result.rows.length !== 1) {
    throw new Error('Wallet account could not be locked.');
  }

  return walletFromRow(result.rows[0]);
}

async function writeWallet(db, guildId, userId, wallet, amount) {
  const next = wallet.balance + amount;

  if (!Number.isSafeInteger(next) || next < 0) {
    throw new Error('Insufficient funds or invalid balance.');
  }

  const updatedData = {
    ...wallet.data,
    wallet: next,
  };

  await db.query(
    `UPDATE economy
     SET balance = $3,
         data = $4::jsonb,
         updated_at = CURRENT_TIMESTAMP
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId, next, JSON.stringify(updatedData)]
  );

  return next;
}

async function writeLedger(db, entry) {
  await db.query(
    `INSERT INTO cunvrs_economy_ledger
       (operation_id, guild_id, user_id, actor_id,
        event_type, amount, balance_before,
        balance_after, details)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      entry.operationId,
      entry.guildId,
      entry.userId,
      entry.actorId,
      entry.eventType,
      entry.amount,
      entry.before,
      entry.after,
      JSON.stringify(entry.details || {}),
    ]
  );
}

async function inTransaction(pool, callback) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new Error('PostgreSQL wallet connection is unavailable.');
  }

  const db = await pool.connect();

  try {
    await db.query('BEGIN');

    const result = await callback(db);

    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

/**
 * Earn or spend Unicoins.
 *
 * Pass a stable operationId UUID for each logical action.
 * Reusing an operationId cannot create another ledger entry.
 *
 * Positive amount = earn.
 * Negative amount = spend.
 *
 * Daily earning caps must be enforced separately before
 * this is connected to repeatable reward commands.
 */
export async function changeUnicoins(pool, options) {
  const {
    guildId,
    userId,
    actorId = userId,
    amount,
    eventType,
    operationId,
    details = {},
  } = options;

  checkId(guildId, 'guildId');
  checkId(userId, 'userId');
  checkId(actorId, 'actorId');
  checkOperationId(operationId);

  if (!Number.isSafeInteger(amount) || amount === 0) {
    throw new Error('Amount must be a nonzero safe integer.');
  }

  if (
    typeof eventType !== 'string' ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(eventType)
  ) {
    throw new Error('Invalid wallet event type.');
  }

  return inTransaction(pool, async (db) => {
    await ensureAccount(db, guildId, userId);

    const wallet = await lockedWallet(db, guildId, userId);
    const next = await writeWallet(
      db,
      guildId,
      userId,
      wallet,
      amount
    );

    await writeLedger(db, {
      operationId,
      guildId,
      userId,
      actorId,
      eventType,
      amount,
      before: wallet.balance,
      after: next,
      details,
    });

    return {
      previousBalance: wallet.balance,
      newBalance: next,
      amount,
      operationId,
    };
  });
}

/**
 * Move Unicoins between two wallets atomically.
 *
 * The total number of Unicoins does not change.
 * Both wallet updates and ledger entries commit together.
 */
export async function transferUnicoins(pool, options) {
  const {
    guildId,
    fromUserId,
    toUserId,
    amount,
    operationId,
  } = options;

  checkId(guildId, 'guildId');
  checkId(fromUserId, 'fromUserId');
  checkId(toUserId, 'toUserId');
  checkAmount(amount);
  checkOperationId(operationId);

  if (fromUserId === toUserId) {
    throw new Error('You cannot pay yourself.');
  }

  return inTransaction(pool, async (db) => {
    // Always lock accounts in the same order to avoid deadlocks.
    const ids = [fromUserId, toUserId].sort();

    for (const id of ids) {
      await ensureAccount(db, guildId, id);
    }

    const wallets = new Map();

    for (const id of ids) {
      wallets.set(id, await lockedWallet(db, guildId, id));
    }

    const sender = wallets.get(fromUserId);
    const receiver = wallets.get(toUserId);

    if (sender.balance < amount) {
      throw new Error('Not enough Unicoins in your wallet.');
    }

    const senderAfter = await writeWallet(
      db, guildId, fromUserId, sender, -amount
    );

    const receiverAfter = await writeWallet(
      db, guildId, toUserId, receiver, amount
    );

    await writeLedger(db, {
      operationId,
      guildId,
      userId: fromUserId,
      actorId: fromUserId,
      eventType: 'pay_sent',
      amount: -amount,
      before: sender.balance,
      after: senderAfter,
      details: { toUserId, transferId: operationId },
    });

    await writeLedger(db, {
      operationId: randomUUID(),
      guildId,
      userId: toUserId,
      actorId: fromUserId,
      eventType: 'pay_received',
      amount,
      before: receiver.balance,
      after: receiverAfter,
      details: { fromUserId, transferId: operationId },
    });

    return {
      amount,
      senderBalance: senderAfter,
      receiverBalance: receiverAfter,
      operationId,
    };
  });
}
