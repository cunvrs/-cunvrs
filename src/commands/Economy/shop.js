import { SlashCommandBuilder, EmbedBuilder, MessageFlags, ChannelType } from 'discord.js';
import { getPaymentPool } from './modules/paymentHandler.js';
import { UNICOIN_EMOJI } from '../../utils/wallet.js';
import { requestRedemption } from '../../services/redemptions/redemptionService.js';
import { sendRedemptionLog } from '../../services/redemptions/redemptionLogs.js';
import { REDEMPTION_TICKET_CONFIG } from '../../services/redemptions/ticketConfig.js';
import {
  CUNVRS_SHOP_CATALOG,
  CUNVRS_SHOP_CATEGORIES,
  findCatalogItem,
} from '../../config/shop/cunvrsCatalog.js';

const PINK = 0xFFEDF4;
const COLLECTIBLE_NAMES = new Map([
  ['pink_ribbon', 'Pink Ribbon'],
  ['lucky_charm', 'Lucky Charm'],
  ['rose_badge', 'Rose Badge'],
]);
const rewardChoices = CUNVRS_SHOP_CATALOG.map(({ name, id }) => ({ name, value: id }));
const categoryChoices = Object.entries(CUNVRS_SHOP_CATEGORIES)
  .map(([value, name]) => ({ name, value }));

function embed(description) {
  return new EmbedBuilder().setColor(PINK).setDescription(description)
    .setFooter({ text: 'cunvrs. shop · staff fulfillment' });
}

const formatPrice = price => price === null
  ? 'Price requires staff review'
  : `${UNICOIN_EMOJI} ${price.toLocaleString('en-US')}`;

function inventoryFromData(data) {
  const inv = data?.inventory ?? {};
  if (!inv || typeof inv !== 'object' || Array.isArray(inv)) {
    throw new Error('Invalid existing inventory.');
  }
  return inv;
}

export default {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Browse and purchase cunvrs. rewards')
    .setDMPermission(false)
    .addSubcommand(sub => sub.setName('browse')
      .setDescription('Browse the reward catalog')
      .addStringOption(opt => opt.setName('category')
        .setDescription('Which type of rewards?')
        .addChoices(...categoryChoices)))
    .addSubcommand(sub => sub.setName('item')
      .setDescription('See an item and its price')
      .addStringOption(opt => opt.setName('reward')
        .setDescription('Select a reward')
        .setRequired(true)
        .addChoices(...rewardChoices)))
    .addSubcommand(sub => sub.setName('buy')
      .setDescription('Reserve Unicoins for a reward in your redemption ticket')
      .addStringOption(opt => opt.setName('item')
        .setDescription('Select a reward')
        .setRequired(true)
        .addChoices(...rewardChoices)))
    .addSubcommand(sub => sub.setName('inventory')
      .setDescription('View your existing collectibles (read-only)')),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guildId) {
      await interaction.editReply({content:'♡ use the shop inside a server!'});
      return;
    }
    try {
      const sub = interaction.options.getSubcommand();
      if (sub === 'browse') {
        const category = interaction.options.getString('category')?.toLowerCase();
        const sections = Object.entries(CUNVRS_SHOP_CATEGORIES)
          .filter(([key]) => !category || key === category);
        if (!sections.length) {
          await interaction.editReply({ content: '♡ Choose a category: ugc, robux, or discord.' });
          return;
        }
        const embeds = sections.map(([key, title]) => {
          const lines = CUNVRS_SHOP_CATALOG.filter(item => item.category === key)
            .map(item => `♡ **${item.name}** · ${formatPrice(item.price)}`);
          return embed(lines.join('\n') + '\n\n-# ♡ use /shop buy in your redemption ticket')
            .setTitle(`🎀 ${title}`);
        });
        await interaction.editReply({ embeds });
        return;
      }
      if (sub === 'item' || sub === 'buy') {
        const input = interaction.options._positional?.slice(1).join(' ') ||
          interaction.options.getString(sub === 'item' ? 'reward' : 'item');
        const item = findCatalogItem(input);
        if (!item) {
          await interaction.editReply({ content: '♡ I couldn’t find that reward. Try /shop browse for item names.' });
          return;
        }
        if (sub === 'buy') {
          if (!item.enabled) {
            await interaction.editReply({ content: 'Ask staff for a quote for this reward.' });
            return;
          }
          if (process.env.CUNVRS_REDEMPTIONS_ENABLED !== 'true') {
            await interaction.editReply({ content: 'Shop purchases are temporarily unavailable.' });
            return;
          }
          if (interaction.channel?.type !== ChannelType.GuildText ||
              interaction.channel.parentId !== REDEMPTION_TICKET_CONFIG.categoryId) {
            await interaction.editReply({
              content: `Open a ticket in <#${REDEMPTION_TICKET_CONFIG.panelChannelId}> and use /shop buy inside it.`,
            });
            return;
          }
          const result = await requestRedemption({
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            userId: interaction.user.id,
            interactionId: interaction.id,
            itemCode: item.id,
            storefront: true,
          });
          if (!result.success) {
            await interaction.editReply({ content: result.reason });
            return;
          }
          await interaction.editReply({
            content: `**${result.itemName}** requested. ${result.reserved.toLocaleString('en-US')} Unicoins reserved pending staff approval.\n` +
              `Request ID: \`${result.redemptionId}\``,
          });
          await sendRedemptionLog(interaction, {
            action: 'Shop redemption requested',
            userId: interaction.user.id,
            redemptionId: result.redemptionId,
            reward: result.itemName,
            amount: result.reserved,
          });
          return;
        }
        await interaction.editReply({ embeds: [embed(
          `## 🎀 ⋮ **__${item.name}__**\n\n` +
          `${formatPrice(item.price)}\n` +
          `♡ category: **${CUNVRS_SHOP_CATEGORIES[item.category]}**\n` +
          (item.enabled ? 'Use /shop buy in your redemption ticket.' : 'Contact staff for a quote.')
        )] });
        return;
      }
      if (sub === 'inventory') {
        const result = await getPaymentPool().query(
          'SELECT data FROM economy WHERE guild_id=$1 AND user_id=$2',
          [interaction.guildId, interaction.user.id]
        );
        const inventory = inventoryFromData(result.rows[0]?.data ?? {});
        const lines = Object.entries(inventory)
          .filter(([, quantity]) => Number.isSafeInteger(Number(quantity)) && Number(quantity) > 0)
          .map(([id, quantity]) => `♡ **${COLLECTIBLE_NAMES.get(id) ?? id}** × ${quantity}`);
        await interaction.editReply({ embeds: [embed(
          '## 🎀 ⋮ **__your collectibles__**\n\n' +
          (lines.join('\n') || '♡ your inventory is empty!')
        )] });
      }
    } catch (error) {
      console.error('[CUNVRS V2 SHOP]', error);
      await interaction.editReply({ content:
        '♡ shop unavailable. Please try again later.' }).catch(()=>{});
    }
  },
};
