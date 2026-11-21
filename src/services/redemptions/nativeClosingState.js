import { ChannelType } from 'discord.js';

import { getPaymentPool } from '../../commands/Economy/modules/paymentHandler.js';
import { REDEMPTION_TICKET_CONFIG as config } from './ticketConfig.js';
import { requireRedemptionStaffAccess } from './redemptionStaffAuth.js';

function validate(interaction) {
  if (process.env.CUNVRS_REDEMPTIONS_ENABLED !== 'true') {
    throw new Error('Redemptions are disabled.');
  }

  requireRedemptionStaffAccess(interaction, 'close');

  if (
    !interaction.guildId ||
    !interaction.channelId ||
    interaction.channel?.id !== interaction.channelId ||
    interaction.channel?.type !== ChannelType.GuildText ||
    interaction.channel?.parentId !== config.categoryId ||
    !interaction.user?.id
  ) {
    throw new Error('Not a verified redemption ticket channel.');
  }
}

async function runLocked(interaction, pool, work) {
  const db = await pool.connect();
  let open = false;

  try {
    await db.query('BEGIN');
    open = true;

    await db.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      [interaction.guildId, interaction.channelId]
    );

    const result = await work(db);

    await db.query('COMMIT');
    open = false;

    return result;
  } catch (error) {
    if (open) {
      await db.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    db.release();
  }
}

export async function beginNativeTicketClosing(
  interaction,
  options = {}
) {
  validate(interaction);

  const pool = options.pool ?? getPaymentPool();

  return runLocked(interaction, pool, async db => {
    const ids = [
      interaction.guildId,
      interaction.channelId
    ];

    const owners = await db.query(
      `SELECT owner_id
       FROM cunvrs_ticketcord_owners
       WHERE guild_id=$1 AND channel_id=$2
         AND verification_method='cunvrs_native_created'
       FOR SHARE`,
      ids
    );

    if (owners.rows.length !== 1) {
      return {
        success: false,
        reason: 'Native ticket ownership not verified.'
      };
    }

    const unresolved = await db.query(
      `SELECT COUNT(*)::integer AS count
       FROM cunvrs_redemptions
       WHERE guild_id=$1 AND channel_id=$2
         AND status NOT IN ('declined', 'delivered')`,
      ids
    );

    const count = Number(unresolved.rows[0]?.count);

    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('Could not verify redemption statuses.');
    }

    if (count > 0) {
      return {
        success: false,
        reason: `${count} unresolved redemption(s).`
      };
    }

    const created = await db.query(
      `INSERT INTO cunvrs_native_redemption_closures
         (guild_id, channel_id, owner_id, state, started_by)
       VALUES ($1, $2, $3, 'closing', $4)
       ON CONFLICT (guild_id, channel_id) DO NOTHING
       RETURNING state`,
      [
        interaction.guildId,
        interaction.channelId,
        owners.rows[0].owner_id,
        interaction.user.id
      ]
    );

    if (created.rows.length !== 1) {
      return {
        success: false,
        reason: 'This ticket is already closing or closed.'
      };
    }

    return {
      success: true,
      state: 'closing',
      ownerId: owners.rows[0].owner_id
    };
  });
}

export async function cancelNativeTicketClosing(
  interaction,
  options = {}
) {
  validate(interaction);

  const pool = options.pool ?? getPaymentPool();

  return runLocked(interaction, pool, async db => {
    const removed = await db.query(
      `DELETE FROM cunvrs_native_redemption_closures
       WHERE guild_id=$1
         AND channel_id=$2
         AND started_by=$3
         AND state='closing'
         AND archive_message_id IS NULL
       RETURNING channel_id`,
      [
        interaction.guildId,
        interaction.channelId,
        interaction.user.id
      ]
    );

    return {
      success: removed.rows.length === 1
    };
  });
}
