import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  LabelBuilder,
  MessageFlags,
  PermissionFlagsBits,
  ComponentType,
  EmbedBuilder,
} from 'discord.js';
import { createHash } from 'node:crypto';
import { InteractionHelper } from '../../../utils/interactionHelper.js';
import { logger } from '../../../utils/logger.js';
import { getPaymentPool } from './paymentHandler.js';
import { changeUnicoins, UNICOIN_EMOJI } from '../../../utils/wallet.js';

const PINK = 0xFFEDF4;
const MAX_ADJUSTMENT = 1_000_000;

function authorized(interaction, guild) {
  return interaction.guildId === guild.id && (
    interaction.user.id === guild.ownerId ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );
}

function operationId(interactionId) {
  const h = createHash('sha256')
    .update(`cunvrs:admin-wallet:${interactionId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function ensureV2(pool) {
  const result = await pool.query('SELECT MAX(version) AS version FROM schema_migrations');
  if (Number(result.rows[0]?.version) !== 2) {
    throw new Error('Wallet administration requires economy schema v2.');
  }
}

async function buildDashboardEmbed(guild, pool) {
  await ensureV2(pool);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::text AS users, COALESCE(SUM(balance), 0)::text AS total
     FROM economy WHERE guild_id = $1`,
    [guild.id]
  );
  const count = BigInt(rows[0].users);
  const total = BigInt(rows[0].total);
  const average = count ? total / count : 0n;

  return new EmbedBuilder()
    .setColor(PINK)
    .setTitle('🎀 cunvrs. ⋮ Unicoin dashboard')
    .setDescription(`Manage **${guild.name}** Unicoins.\nOnly server administrators can make adjustments. Every change is logged.`)
    .addFields(
      { name: `${UNICOIN_EMOJI} In circulation`, value: total.toLocaleString('en-US'), inline: true },
      { name: '♡ Wallet accounts', value: count.toLocaleString('en-US'), inline: true },
      { name: '♡ Average wallet', value: average.toLocaleString('en-US'), inline: true },
      { name: '♡ Currency', value: UNICOIN_EMOJI + ' Unicoins', inline: false }
    )
    .setFooter({ text: 'cunvrs. economy • expires after 10 minutes' });
}

function buildMenu(guildId) {
  return new StringSelectMenuBuilder()
    .setCustomId(`economy_dashboard_${guildId}`)
    .setPlaceholder('Select a wallet action...')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Add Unicoins').setDescription('Credit a member wallet • audited')
        .setValue('add_currency').setEmoji('🎀'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Remove Unicoins').setDescription('Debit a member wallet • audited')
        .setValue('remove_currency').setEmoji('🪙')
    );
}

async function refresh(root, guild, pool) {
  await InteractionHelper.safeEditReply(root, {
    embeds: [await buildDashboardEmbed(guild, pool)],
    components: [new ActionRowBuilder().addComponents(buildMenu(guild.id))],
  });
}

async function handleAdjustment(selected, root, guild, pool, direction) {
  if (!authorized(selected, guild)) {
    await selected.reply({ content: '♡ administrator permission is required.', flags: MessageFlags.Ephemeral });
    return;
  }

  const modalId = `cunvrs_wallet_${direction}_${guild.id}_${selected.id}`;
  const userMenu = new UserSelectMenuBuilder()
    .setCustomId('target_user')
    .setPlaceholder('Choose a member...')
    .setRequired(true).setMinValues(1).setMaxValues(1);
  const userLabel = new LabelBuilder()
    .setLabel('Target member').setUserSelectMenuComponent(userMenu);
  const amountInput = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel('Number of Unicoins')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('100')
    .setMinLength(1).setMaxLength(7).setRequired(true);
  const amountRow = new ActionRowBuilder().addComponents(amountInput);
  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle(direction === 'add' ? 'Add Unicoins' : 'Remove Unicoins')
    .addLabelComponents(userLabel)
    .addComponents(amountRow);

  await selected.showModal(modal);
  const submitted = await selected.awaitModalSubmit({
    filter: i => i.customId === modalId && i.user.id === selected.user.id && i.guildId === guild.id,
    time: 120_000,
  }).catch(() => null);
  if (!submitted) return;

  if (!authorized(submitted, guild)) {
    await submitted.reply({ content: '♡ administrator permission is required.', flags: MessageFlags.Ephemeral });
    return;
  }

  const amountText = submitted.fields.getTextInputValue('amount').trim();
  if (!/^[1-9]\d*$/.test(amountText)) {
    await submitted.reply({ content: '♡ enter a positive whole number.', flags: MessageFlags.Ephemeral });
    return;
  }
  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount) || amount > MAX_ADJUSTMENT) {
    await submitted.reply({ content: `♡ adjustments must be at most ${MAX_ADJUSTMENT.toLocaleString('en-US')} Unicoins.`, flags: MessageFlags.Ephemeral });
    return;
  }

  const userId = submitted.fields.getField('target_user').values[0];
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member || member.user.bot) {
    await submitted.reply({ content: '♡ please select a human member of this server.', flags: MessageFlags.Ephemeral });
    return;
  }

  await submitted.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await ensureV2(pool);
    const result = await changeUnicoins(pool, {
      guildId: guild.id,
      userId,
      actorId: submitted.user.id,
      amount: direction === 'add' ? amount : -amount,
      eventType: direction === 'add' ? 'admin_credit' : 'admin_debit',
      operationId: operationId(submitted.id),
      details: { source: 'economy_dashboard', administrator: submitted.user.id },
    });
    await submitted.editReply({
      content: `${UNICOIN_EMOJI} **${direction === 'add' ? 'Added' : 'Removed'} ${amount.toLocaleString('en-US')} Unicoins** ${direction === 'add' ? 'to' : 'from'} <@${userId}>.\n♡ New wallet: **${result.newBalance.toLocaleString('en-US')}**\n♡ Recorded in the transaction ledger.`,
      allowedMentions: { parse: [] },
    });
    logger.info('[CUNVRS ADMIN WALLET]', {
      guildId: guild.id, adminId: submitted.user.id, targetUserId: userId,
      amount: direction === 'add' ? amount : -amount,
      operationId: result.operationId,
    });
    await refresh(root, guild, pool).catch(error => logger.warn('Dashboard refresh failed:', error));
  } catch (error) {
    logger.error('Unicoin adjustment failed:', error);
    await submitted.editReply({
      content: '♡ the adjustment could not be confirmed. Check the wallet and ledger before trying again.',
    }).catch(() => {});
  }
}

export default {
  prefixOnly: false,
  async execute(interaction, config, client) {
    const guild = interaction.guild;
    if (!guild || !authorized(interaction, guild)) {
      const payload = { content: '♡ only server administrators can open this dashboard.', flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: payload.content, embeds: [], components: [] });
      } else {
        await interaction.reply(payload);
      }
      return;
    }

    const pool = getPaymentPool();
    await refresh(interaction, guild, pool);
    const message = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 600_000,
      filter: i => i.user.id === interaction.user.id && i.customId === `economy_dashboard_${guild.id}`,
    });

    collector.on('collect', async selected => {
      try {
        if (!authorized(selected, guild)) {
          await selected.reply({ content: '♡ administrator permission is required.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (selected.values[0] === 'add_currency') {
          await handleAdjustment(selected, interaction, guild, pool, 'add');
        } else if (selected.values[0] === 'remove_currency') {
          await handleAdjustment(selected, interaction, guild, pool, 'remove');
        } else {
          await selected.reply({ content: '♡ unknown action.', flags: MessageFlags.Ephemeral });
        }
      } catch (error) {
        logger.error('Unicoin dashboard action failed:', error);
        if (!selected.replied && !selected.deferred) {
          await selected.reply({ content: '♡ this action failed. Please try again.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      }
    });
    collector.on('end', () => {
      InteractionHelper.safeEditReply(interaction, { components: [] }).catch(() => {});
    });
  },
};
