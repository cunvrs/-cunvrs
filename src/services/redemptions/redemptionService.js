
import { createHash } from 'node:crypto';
import { getPaymentPool } from '../../commands/Economy/modules/paymentHandler.js';

export const REDEMPTION_CATALOG = Object.freeze({
  ugc_reward: Object.freeze({
    name: '🎀 UGC Reward',
    type: 'ugc',
    price: 12000,
    enabled: true,
  }),
  robux_50: Object.freeze({
    name: '💎 50 Robux',
    type: 'robux',
    price: 30000,
    enabled: false, // Requires policy and delivery review.
  }),
  vip_30d: Object.freeze({
    name: '👑 30-Day VIP',
    type: 'vip',
    price: 20000,
    enabled: true,
  }),
});

function checkId(id) {
  if (typeof id !== 'string' || !/^\d{15,22}$/.test(id)) {
    throw new Error('Invalid Discord ID.');
  }
}

function requestUuid(interactionId) {
  checkId(interactionId);
  const hash = createHash('sha256')
    .update(`cunvrs:redemption:${interactionId}`)
    .digest('hex');

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

function eventUuid(redemptionId, action) {
  const hash = createHash('sha256')
    .update(`cunvrs:redemption:${redemptionId}:${action}`)
    .digest('hex');

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

function amount(value) {
  const n = Number(value);

  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error('Invalid wallet or redemption amount.');
  }

  return n;
}

function checkWallet(row) {
  if (!row) throw new Error('Wallet account missing.');

  const data = row.data ?? {};
  const wallet = amount(row.balance);
  const saved = amount(data.wallet ?? row.balance);

  if (wallet !== saved) {
    throw new Error('Wallet consistency error.');
  }

  return { wallet, data };
}

async function ensureAccount(db, guildId, userId) {
  await db.query(
    `INSERT INTO guilds (id) VALUES ($1)
     ON CONFLICT (id) DO NOTHING`,
    [guildId]
  );

  await db.query(
    `INSERT INTO users (id) VALUES ($1)
     ON CONFLICT (id) DO NOTHING`,
    [userId]
  );

  await db.query(
    `INSERT INTO economy
       (guild_id,user_id,balance,bank,data)
     VALUES ($1,$2,0,0,'{"wallet":0,"bank":0,"level":1}'::jsonb)
     ON CONFLICT (guild_id,user_id) DO NOTHING`,
    [guildId, userId]
  );
}

async function lockWallet(db, guildId, userId) {
  const result = await db.query(
    `SELECT balance,data FROM economy
     WHERE guild_id=$1 AND user_id=$2 FOR UPDATE`,
    [guildId, userId]
  );

  return checkWallet(result.rows[0]);
}

async function saveWallet(db, guildId, userId, data, next) {
  await db.query(
    `UPDATE economy
     SET balance=$3,data=$4::jsonb,updated_at=NOW()
     WHERE guild_id=$1 AND user_id=$2`,
    [
      guildId,
      userId,
      next,
      JSON.stringify({ ...data, wallet: next }),
    ]
  );
}

async function writeLedger(
  db, operationId, guildId, userId, actorId,
  eventType, value, before, after, details
) {
  await db.query(
    `INSERT INTO cunvrs_economy_ledger
     (operation_id,guild_id,user_id,actor_id,
      event_type,amount,balance_before,balance_after,details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      operationId, guildId, userId, actorId,
      eventType, value, before, after,
      JSON.stringify(details),
    ]
  );
}

async function transaction(work) {
  const db = await getPaymentPool().connect();
  let active = false;

  try {
    const version = await db.query(
      'SELECT MAX(version) AS version FROM schema_migrations'
    );

    if (Number(version.rows[0]?.version) !== 2) {
      throw new Error('Economy schema v2 required.');
    }

    await db.query('BEGIN');
    active = true;

    const result = await work(db);

    await db.query('COMMIT');
    active = false;
    return result;
  } catch (error) {
    if (active) {
      await db.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    db.release();
  }
}

export async function requestRedemption({
  guildId,
  channelId,
  userId,
  interactionId,
  itemCode,
}) {
  for (const id of [
    guildId, channelId, userId, interactionId
  ]) checkId(id);

  const item = REDEMPTION_CATALOG[itemCode];

  if (!item?.enabled) {
    return { success: false, reason: 'Reward unavailable.' };
  }

  return transaction(async db => {
    const id = requestUuid(interactionId);


    // CUNVRS_NATIVE_CLOSING_GUARD_V1
    // Coordinate redemption creation with future Close Ticket transactions.
    await db.query(
      `SELECT pg_advisory_xact_lock(
         hashtext($1), hashtext($2)
       )`,
      [guildId, channelId]
    );

    const closing = await db.query(
      `SELECT state
       FROM cunvrs_native_redemption_closures
       WHERE guild_id=$1 AND channel_id=$2`,
      [guildId, channelId]
    );

    if (closing.rows.length) {
      return {
        success: false,
        reason: 'This redemption ticket is closing or closed.',
      };
    }

await ensureAccount(db, guildId, userId);
    const { wallet, data } = await lockWallet(
      db, guildId, userId
    );

    // Idempotency for Discord retries.
    const existing = await db.query(
      `SELECT id,status FROM cunvrs_redemptions WHERE id=$1`,
      [id]
    );

    if (existing.rows.length) {
      return {
        success: false,
        reason: 'This request was already processed.',
        redemptionId: id,
      };
    }

    const owner = await db.query(
      `SELECT owner_id FROM cunvrs_ticketcord_owners
       WHERE guild_id=$1 AND channel_id=$2
         AND verification_method='cunvrs_native_created'`,
      [guildId, channelId]
    );

    if (owner.rows[0]?.owner_id !== userId) {
      return {
        success: false,
        reason: 'Ticket owner has not been verified.',
      };
    }

    const pending = await db.query(
      `SELECT id FROM cunvrs_redemptions
       WHERE guild_id=$1 AND user_id=$2
       AND status='pending_approval'`,
      [guildId, userId]
    );

    if (pending.rows.length) {
      return {
        success: false,
        reason: 'You already have a pending redemption.',
      };
    }

    if (wallet < item.price) {
      return {
        success: false,
        reason: 'Not enough Unicoins.',
      };
    }

    // A wallet debit and redemption hold occur together.
    const next = wallet - item.price;

    await db.query(
      `INSERT INTO cunvrs_redemptions
       (id,guild_id,user_id,channel_id,item_code,
        ticket_type,coins_reserved,status,details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,
               'pending_approval',$8::jsonb)`,
      [
        id, guildId, userId, channelId, itemCode,
        item.type, item.price,
        JSON.stringify({
          itemName: item.name,
          history: [{
            action: 'requested',
            actorId: userId,
            at: new Date().toISOString(),
          }],
        }),
      ]
    );

    await saveWallet(db, guildId, userId, data, next);

    await writeLedger(
      db, eventUuid(id, 'hold'), guildId, userId,
      userId, 'redemption_hold',
      -item.price, wallet, next,
      { redemptionId: id, itemCode }
    );

    return {
      success: true,
      redemptionId: id,
      itemName: item.name,
      reserved: item.price,
      wallet: next,
      status: 'pending_approval',
    };
  });
}

export async function transitionRedemption({
  guildId,
  redemptionId,
  staffId,
  staffAuthorized,
  action,
  fulfillmentEvidence,
  channelId,
}) {
  checkId(guildId);
  checkId(staffId);
  // CUNVRS_MANDATORY_TICKET_SECURITY_V2
  checkId(channelId);

  if (staffAuthorized !== true) {
    throw new Error('Manage Server permission required.');
  }

  if (
    typeof redemptionId !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(redemptionId)
  ) {
    throw new Error('Invalid redemption ID.');
  }

  const transitions = {
    approve: {
      from: ['pending_approval'],
      to: 'approved',
    },
    decline: {
      from: ['pending_approval', 'approved'],
      to: 'declined',
    },
    deliver: {
      from: ['approved', 'in_progress'],
      to: 'delivered',
    },
  };

  const rule = transitions[action];
  if (!rule) throw new Error('Unknown redemption action.');

  if (action === 'deliver') {
    if (
      typeof fulfillmentEvidence !== 'string' ||
      fulfillmentEvidence.trim().length < 8 ||
      fulfillmentEvidence.length > 500
    ) {
      throw new Error(
        'Delivery requires a fulfillment reference (8-500 characters).'
      );
    }
  }

  return transaction(async db => {
    const result = await db.query(
      `SELECT * FROM cunvrs_redemptions
       WHERE id=$1 AND guild_id=$2 FOR UPDATE`,
      [redemptionId, guildId]
    );

    const record = result.rows[0];

    if (!record) {
      return { success: false, reason: 'Redemption not found.' };
    }

    // Verify native ticket ownership inside the same transaction.
if (record.channel_id !== channelId) {
        return {
          success: false,
          reason: 'Redemption belongs to another ticket.'
        };
      }

      const ownership = await db.query(
        `SELECT 1
         FROM cunvrs_ticketcord_owners
         WHERE guild_id=$1
           AND channel_id=$2
           AND owner_id=$3
           AND verification_method='cunvrs_native_created'
         FOR SHARE`,
        [guildId, channelId, record.user_id]
      );

      if (!ownership.rows.length) {
        return {
          success: false,
          reason: 'Native ticket ownership could not be verified.'
        };
      }

    if (!rule.from.includes(record.status)) {
      return {
        success: false,
        reason: `Cannot ${action} a ${record.status} redemption.`,
      };
    }

    if (record.user_id === staffId) {
      throw new Error('Staff cannot process their own redemption.');
    }

    let walletAfter = null;

    if (action === 'decline') {
      const { wallet, data } = await lockWallet(
        db, guildId, record.user_id
      );

      const refund = amount(record.coins_reserved);
      const next = wallet + refund;

      if (!Number.isSafeInteger(next)) {
        throw new Error('Refund would overflow wallet.');
      }

      await saveWallet(
        db, guildId, record.user_id, data, next
      );

      await writeLedger(
        db,
        eventUuid(redemptionId, 'refund'),
        guildId,
        record.user_id,
        staffId,
        'redemption_refund',
        refund,
        wallet,
        next,
        { redemptionId }
      );

      walletAfter = next;
    }

    const details = record.details ?? {};
    const history = Array.isArray(details.history)
      ? details.history
      : [];

    await db.query(
      `UPDATE cunvrs_redemptions
       SET status=$3,
           updated_at=NOW(),
           details=$4::jsonb
       WHERE id=$1 AND guild_id=$2`,
      [
        redemptionId,
        guildId,
        rule.to,
        JSON.stringify({
          ...details,
          history: [
            ...history,
            {
              action,
              actorId: staffId,
              ...(action === 'deliver'
                ? { fulfillmentEvidence: fulfillmentEvidence.trim() }
                : {}),
              at: new Date().toISOString(),
            },
          ],
        }),
      ]
    );

    return {
      success: true,
      redemptionId,
      status: rule.to,
      userId: record.user_id,
      channelId: record.channel_id,
      itemCode: record.item_code,
      walletAfter,
    };
  });
}

export async function getRedemption(guildId, redemptionId) {
  checkId(guildId);

  const result = await getPaymentPool().query(
    `SELECT * FROM cunvrs_redemptions
     WHERE guild_id=$1 AND id=$2`,
    [guildId, redemptionId]
  );

  return result.rows[0] ?? null;
}
