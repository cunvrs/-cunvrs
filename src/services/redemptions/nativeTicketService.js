import { buildRedemptionStaffControls } from './redemptionStaffControls.js';
﻿import {
  ChannelType,
  PermissionFlagsBits
} from 'discord.js';

import { getPaymentPool } from '../../commands/Economy/modules/paymentHandler.js';
import { REDEMPTION_TICKET_CONFIG } from './ticketConfig.js';

const P = PermissionFlagsBits;

export async function createNativeRedemptionTicket(interaction, options = {}) {
  if (process.env.CUNVRS_REDEMPTIONS_ENABLED !== 'true') {
    throw new Error('Redemption tickets are not enabled yet.');
  }

  const guild = interaction.guild;
  const user = interaction.user;
  const config = REDEMPTION_TICKET_CONFIG;

  if (!guild || !user || !interaction.client.user) {
    throw new Error('A Discord server is required.');
  }

  if (interaction.channelId !== config.panelChannelId) {
    throw new Error('Use the official redemption panel.');
  }

  const category = await guild.channels.fetch(config.categoryId);

  if (
    !category ||
    category.type !== ChannelType.GuildCategory
  ) {
    throw new Error('Redemption category is unavailable.');
  }

  // Validate every configured staff role before creating a ticket.
  const roles = await guild.roles.fetch();

  for (const roleId of config.staffRoleIds) {
    if (!roles.has(roleId)) {
      throw new Error(`Configured staff role is missing: ${roleId}`);
    }
  }

  const pool = options.pool ?? getPaymentPool();
  const db = await pool.connect();

  let transactionOpen = false;
  let commitAttempted = false;
  let createdChannel = null;

  try {
    await db.query('BEGIN');
    transactionOpen = true;

    // Serialize simultaneous requests from the same member.
    await db.query(
      `SELECT pg_advisory_xact_lock(
        hashtext($1), hashtext($2)
      )`,
      [guild.id, user.id]
    );

    const existing = await db.query(
      `SELECT channel_id
       FROM cunvrs_ticketcord_owners
       WHERE guild_id = $1 AND owner_id = $2
         AND verification_method = 'cunvrs_native_created'`,
      [guild.id, user.id]
    );

    for (const row of existing.rows) {
      // Deleted channels return null.
      // Unexpected Discord API failures stop creation safely.
      const channel = await guild.channels.fetch(row.channel_id);


      // CUNVRS_MOVED_TICKET_PROTECTION
      if (
        channel &&
        (
          channel.parentId !== config.categoryId ||
          channel.type !== ChannelType.GuildText
        )
      ) {
        throw new Error(
          'Existing redemption ticket needs staff review.'
        );
      }

      if (channel && channel.parentId === config.categoryId && channel.type === ChannelType.GuildText) {
        await db.query('COMMIT');
        transactionOpen = false;

        return {
          created: false,
          channelId: channel.id
        };
      }
    }

    const overwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [P.ViewChannel]
      },
      {
        id: user.id,
        allow: [
          P.ViewChannel,
          P.SendMessages,
          P.ReadMessageHistory
        ]
      },
      {
        id: interaction.client.user.id,
        allow: [
          P.ViewChannel,
          P.SendMessages,
          P.ReadMessageHistory,
          P.ManageChannels
        ]
      },
      ...config.staffRoleIds.map(id => ({
        id,
        allow: [
          P.ViewChannel,
          P.SendMessages,
          P.ReadMessageHistory
        ]
      }))
    ];

    createdChannel = await guild.channels.create({
      name: `redeem-${user.id.slice(-10)}`,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: overwrites,
      reason: `cunvrs redemption ticket for ${user.id}`
    });

    // Satisfy the existing relational foreign keys.
    await db.query(
      `INSERT INTO guilds (id)
       VALUES ($1)
       ON CONFLICT (id) DO NOTHING`,
      [guild.id]
    );

    await db.query(
      `INSERT INTO users (id)
       VALUES ($1), ($2)
       ON CONFLICT (id) DO NOTHING`,
      [user.id, interaction.client.user.id]
    );

    await db.query(
      `INSERT INTO cunvrs_ticketcord_owners
       (
         guild_id,
         channel_id,
         owner_id,
         verified_by,
         verification_method
       )
       VALUES ($1, $2, $3, $4, 'cunvrs_native_created')`,
      [
        guild.id,
        createdChannel.id,
        user.id,
        interaction.client.user.id
      ]
    );

    commitAttempted = true;
    await db.query('COMMIT');
    transactionOpen = false;

  } catch (error) {
    if (transactionOpen) {
      await db.query('ROLLBACK').catch(() => {});
    }

    // Only delete an incomplete ticket if COMMIT was not attempted.
    // A failed COMMIT response can be ambiguous.
    if (createdChannel && !commitAttempted) {
      await createdChannel.delete(
        'Rolling back incomplete redemption ticket'
      ).catch(cleanupError => {
        console.error(
          '[redemption ticket cleanup failed]',
          cleanupError
        );
      });
    }

    throw error;
  } finally {
    db.release();
  }

  // Channel exists and ownership is committed before sending.
  // A welcome-message failure must not erase the owner record.
  try {
    await createdChannel.send({
      content:
        `## 🎀 ⋮ __redemption ticket!__\n\n` +
        `welcome <@${user.id}>!\n\n` +
        `♡ use **/shop buy** to request a shop reward.\n` +
        `♡ staff will review your request.\n` +
        `♡ keep your ticket open until fulfillment is complete.`,
      allowedMentions: {
        users: [user.id],
        parse: []
      }
    });
  } catch (error) {
    console.error(
      '[redemption welcome message failed]',
      error
    );
  }

  // CUNVRS_NATIVE_STAFF_PANEL
  // Ownership is already committed before we send controls.
  try {
    await createdChannel.send(buildRedemptionStaffControls());
  } catch (error) {
    console.error(
      '[redemption staff panel delivery failed]',
      error
    );
  }

  return {
    created: true,
    channelId: createdChannel.id
  };
}
