import { sendRedemptionLog } from './redemptionLogs.js';

import { PermissionFlagsBits, ChannelType } from 'discord.js';

import {
  REDEMPTION_CATALOG,
  requestRedemption,
  transitionRedemption,
  getRedemption
} from './redemptionService.js';

import {
  verifyTicketOwner
} from './ticketOwnership.js';

import {
  getPaymentPool
} from '../../commands/Economy/modules/paymentHandler.js';

function isStaff(interaction) {
  return interaction.memberPermissions?.has(
    PermissionFlagsBits.ManageGuild
  ) === true;
}

function ensureTicket(interaction) {
  const category =
    process.env.TICKETCORD_REDEMPTION_CATEGORY_ID;

  if (!category || !/^\d{15,22}$/.test(category)) {
    throw new Error('Redemption ticket category not configured.');
  }

  if (
    !interaction.guildId ||
    interaction.channel?.type !== ChannelType.GuildText ||
    interaction.channel.parentId !== category
  ) {
    throw new Error(
      'This command only works in a Ticketcord redemption ticket.'
    );
  }
}

function reply(interaction, content) {
  return interaction.editReply({ content });
}

export const redemptionRewardChoices = Object.entries(
  REDEMPTION_CATALOG
)
  .filter(([, reward]) => reward.enabled)
  .map(([value, reward]) => ({
    name: `${reward.name} - ${reward.price.toLocaleString()} Unicoins`,
    value
  }));

export async function handleRedemptionSubcommand(interaction) {
  try {
    if (process.env.CUNVRS_REDEMPTIONS_ENABLED !== 'true') {
      return reply(
        interaction,
        'Redemptions are temporarily unavailable.'
      );
    }

    ensureTicket(interaction);

    const action = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    const userId = interaction.user.id;

    if (action === 'verifyticket') {
      // CUNVRS_NATIVE_ONLY_VERIFICATION
      return await interaction.editReply({
        content:
          'Manual ticket verification has been retired. ' +
          'Please open a redemption ticket through the official cunvrs. panel.'
      });

      if (!isStaff(interaction)) {
        return reply(interaction, '♡ staff only!');
      }

      const member = interaction.options.getUser(
        'member', true
      );

      const confirmation = interaction.options.getString(
        'confirmation', true
      );

      if (member.bot || member.id === userId) {
        return reply(
          interaction,
          '♡ choose the actual ticket owner.'
        );
      }

      if (confirmation !== 'VERIFY') {
        return reply(
          interaction,
          '♡ enter VERIFY to confirm ticket ownership.'
        );
      }

      const result = await verifyTicketOwner({
        guildId,
        channelId,
        ownerId: member.id,
        staffId: userId,
        staffAuthorized: true,
        ownershipConfirmed: true
      });

      await sendRedemptionLog(interaction, {
        action: 'Ticket owner verified',
        userId: member.id
      });

      return reply(
        interaction,
        result.alreadyVerified
          ? `♡ already verified for <@${member.id}>.`
          : `♡ ticket verified for <@${member.id}>!`
      );
    }

    if (action === 'redeem') {
      const itemCode = interaction.options.getString(
        'reward', true
      );

      const result = await requestRedemption({
        guildId,
        channelId,
        userId,
        interactionId: interaction.id,
        itemCode
      });

      if (!result.success) {
        return reply(interaction, `♡ ${result.reason}`);
      }

      await sendRedemptionLog(interaction, {
        action: 'Redemption requested',
        userId,
        redemptionId: result.redemptionId,
        reward: result.itemName,
        amount: result.reserved
      });

      return reply(
        interaction,
        `♡ **redemption requested!**\n` +
        `reward: ${result.itemName}\n` +
        `reserved: ${result.reserved.toLocaleString()} Unicoins\n` +
        `wallet: ${result.wallet.toLocaleString()} Unicoins\n` +
        `request ID: \`${result.redemptionId}\``
      );
    }

    if (action === 'redemptions') {
      if (!isStaff(interaction)) {
        return reply(interaction, '♡ staff only!');
      }

      const result = await getPaymentPool().query(
        `SELECT id, item_code, status, coins_reserved
         FROM cunvrs_redemptions
         WHERE guild_id=$1 AND channel_id=$2
         ORDER BY requested_at DESC LIMIT 10`,
        [guildId, channelId]
      );

      if (!result.rows.length) {
        return reply(interaction, '♡ no redemptions found!');
      }

      return reply(
        interaction,
        result.rows.map(row =>
          `${row.item_code} — ${row.status}\n` +
          `${Number(row.coins_reserved).toLocaleString()} Unicoins\n` +
          `\`${row.id}\``
        ).join('\n\n')
      );
    }

    if (action === 'manage') {
      if (!isStaff(interaction)) {
        return reply(interaction, '♡ staff only!');
      }

      const redemptionId = interaction.options.getString(
        'request', true
      );

      const choice = interaction.options.getString(
        'action', true
      );

      const fulfillmentEvidence =
        interaction.options.getString('evidence');

      const record = await getRedemption(
        guildId, redemptionId
      );

      if (!record || record.channel_id !== channelId) {
        return reply(
          interaction,
          '♡ redemption not found in this ticket.'
        );
      }

      const result = await transitionRedemption({
        guildId,
        channelId,
        redemptionId,
        staffId: userId,
        staffAuthorized: true,
        action: choice,
        fulfillmentEvidence
      });

      if (!result.success) {
        return reply(interaction, `♡ ${result.reason}`);
      }

      return reply(
        interaction,
        `♡ **redemption updated!**\n` +
        `status: ${result.status}\n` +
        `request: \`${redemptionId}\``
      );
    }

    await sendRedemptionLog(interaction, {
        action: 'Redemption ' + result.status,
        userId: result.userId,
        redemptionId,
        reward: result.itemCode
      });

      return reply(interaction, '♡ unknown redemption action.');
  } catch (error) {
    console.error('[cunvrs redemption]', error);

    return reply(
      interaction,
      '♡ unable to process this request. Please contact staff.'
    );
  }
}
