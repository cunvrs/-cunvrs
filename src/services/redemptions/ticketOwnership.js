import { getPaymentPool } from '../../commands/Economy/modules/paymentHandler.js';

function checkDiscordId(value, label) {
  if (typeof value !== 'string' || !/^\d{15,22}$/.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
}

export async function getVerifiedTicketOwner(guildId, channelId) {
  checkDiscordId(guildId, 'guild ID');
  checkDiscordId(channelId, 'channel ID');

  const pool = getPaymentPool();

  const result = await pool.query(
    `SELECT owner_id, verified_by, verification_method, verified_at
     FROM cunvrs_ticketcord_owners
     WHERE guild_id = $1 AND channel_id = $2`,
    [guildId, channelId]
  );

  return result.rows[0] ?? null;
}

export async function verifyTicketOwner({
  guildId,
  channelId,
  ownerId,
  staffId,
  staffAuthorized,
  ownershipConfirmed,
}) {
  checkDiscordId(guildId, 'guild ID');
  checkDiscordId(channelId, 'channel ID');
  checkDiscordId(ownerId, 'owner ID');
  checkDiscordId(staffId, 'staff ID');

  // These checks must be supplied by the trusted command handler.
  if (staffAuthorized !== true) {
    throw new Error('Manage Server permission required.');
  }

  if (ownershipConfirmed !== true) {
    throw new Error('Ticket ownership must be confirmed by staff.');
  }

  if (ownerId === staffId) {
    throw new Error(
      'Staff cannot self-verify a redemption ticket.'
    );
  }

  const pool = getPaymentPool();
  const db = await pool.connect();
  let transaction = false;

  try {
    await db.query('BEGIN');
    transaction = true;

    await db.query(
      `INSERT INTO guilds (id)
       VALUES ($1)
       ON CONFLICT (id) DO NOTHING`,
      [guildId]
    );

    await db.query(
      `INSERT INTO users (id)
       VALUES ($1), ($2)
       ON CONFLICT (id) DO NOTHING`,
      [ownerId, staffId]
    );

    const inserted = await db.query(
      `INSERT INTO cunvrs_ticketcord_owners
         (
           guild_id, channel_id, owner_id,
           verified_by, verification_method
         )
       VALUES ($1, $2, $3, $4, 'staff_manual')
       ON CONFLICT (channel_id) DO NOTHING
       RETURNING owner_id`,
      [guildId, channelId, ownerId, staffId]
    );

    if (!inserted.rows.length) {
      const existing = await db.query(
        `SELECT guild_id, owner_id
         FROM cunvrs_ticketcord_owners
         WHERE channel_id = $1`,
        [channelId]
      );

      const record = existing.rows[0];

      if (
        !record ||
        record.guild_id !== guildId ||
        record.owner_id !== ownerId
      ) {
        throw new Error(
          'This ticket has already been verified for a different owner.'
        );
      }

      await db.query('COMMIT');
      transaction = false;

      return {
        verified: true,
        alreadyVerified: true,
        ownerId,
      };
    }

    await db.query('COMMIT');
    transaction = false;

    return {
      verified: true,
      alreadyVerified: false,
      ownerId,
    };
  } catch (error) {
    if (transaction) {
      await db.query('ROLLBACK').catch(() => {});
    }

    throw error;
  } finally {
    db.release();
  }
}
