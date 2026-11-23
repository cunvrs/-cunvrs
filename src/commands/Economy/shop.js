import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getPaymentPool } from './modules/paymentHandler.js';
import { UNICOIN_EMOJI } from '../../utils/wallet.js';
import {
  CUNVRS_SHOP_CATALOG,
  CUNVRS_SHOP_CATEGORIES,
  getCatalogItem,
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
    .setFooter({ text: 'cunvrs. shop · preview only · rewards not on sale' });
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
    .setDescription('Browse the upcoming cunvrs. reward shop')
    .setDMPermission(false)
    .addSubcommand(sub => sub.setName('browse')
      .setDescription('Browse the preview catalog')
      .addStringOption(opt => opt.setName('category')
        .setDescription('Which type of rewards?')
        .addChoices(...categoryChoices)))
    .addSubcommand(sub => sub.setName('item')
      .setDescription('See an item and its proposed price')
      .addStringOption(opt => opt.setName('reward')
        .setDescription('Select a reward')
        .setRequired(true)
        .addChoices(...rewardChoices)))
    .addSubcommand(sub => sub.setName('buy')
      .setDescription('Check whether purchases are currently enabled')
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
        const category = interaction.options.getString('category');
        const selection = category
          ? CUNVRS_SHOP_CATALOG.filter(item => item.category === category)
          : CUNVRS_SHOP_CATALOG;
        const title = category ? CUNVRS_SHOP_CATEGORIES[category] : `all ${selection.length} rewards`;
        const lines = selection.map(item =>
          `♡ **${item.name}** · ${formatPrice(item.price)}`
        );
        // Split into smaller embeds to respect Discord's description length limit.
        const chunkSize = 9;
        const embeds = [];
        for (let i=0; i<lines.length; i+=chunkSize) {
          embeds.push(embed(
            `## 🎀 ⋮ **__${title}__**\n\n` +
            lines.slice(i,i+chunkSize).join('\n') +
            '\n\n-# ♡ proposed prices · purchases currently disabled'
          ));
        }
        await interaction.editReply({ embeds });
        return;
      }
      if (sub === 'item' || sub === 'buy') {
        const id = interaction.options.getString(sub === 'item' ? 'reward' : 'item');
        const item = getCatalogItem(id);
        if (!item) throw new Error('Invalid shop item.');
        await interaction.editReply({ embeds: [embed(
          `## 🎀 ⋮ **__${item.name}__**\n\n` +
          `${formatPrice(item.price)}\n` +
          `♡ category: **${CUNVRS_SHOP_CATEGORIES[item.category]}**\n` +
          '♡ status: **awaiting approval**\n\n' +
          'This is a catalog preview. No Unicoins or Shop Tokens have been deducted.'
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
        '♡ shop preview unavailable. Please try again later.' }).catch(()=>{});
    }
  },
};
