
import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { createHash } from 'node:crypto';
import { getPaymentPool } from './modules/paymentHandler.js';
import { UNICOIN_EMOJI } from '../../utils/wallet.js';

const PINK = 0xFFEDF4;

// Collectibles only: no unimplemented bonuses or role delivery.
const ITEMS = [
  {
    id: 'pink_ribbon',
    name: 'Pink Ribbon',
    price: 2500,
    max: 10,
    description: 'A cute collectible ribbon for your inventory.',
  },
  {
    id: 'lucky_charm',
    name: 'Lucky Charm',
    price: 5000,
    max: 10,
    description: 'A decorative charm to collect.',
  },
  {
    id: 'rose_badge',
    name: 'Rose Badge',
    price: 7500,
    max: 5,
    description: 'A pretty collectible badge.',
  },
];

function embed(description) {
  return new EmbedBuilder()
    .setColor(PINK)
    .setDescription(description)
    .setFooter({ text: 'cunvrs. shop' });
}

function operationId(id) {
  const hash = createHash('sha256')
    .update(`cunvrs:shop:${id}`)
    .digest('hex');

  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

function inventoryFromData(data) {
  const inventory = data.inventory ?? {};

  if (
    !inventory ||
    typeof inventory !== 'object' ||
    Array.isArray(inventory)
  ) {
    throw new Error('Invalid inventory data.');
  }

  return inventory;
}

async function purchase(pool, {
  guildId,
  userId,
  interactionId,
  itemId,
  quantity,
}) {
  const item = ITEMS.find(entry => entry.id === itemId);

  if (!item || !Number.isInteger(quantity) ||
      quantity < 1 || quantity > 10) {
    return { error: 'invalid purchase request' };
  }

  const cost = item.price * quantity;
  const op = operationId(interactionId);
  const db = await pool.connect();
  let started = false;

  try {
    const version = await db.query(
      'SELECT MAX(version) AS version FROM schema_migrations'
    );

    if (Number(version.rows[0]?.version) !== 2) {
      throw new Error('Economy schema v2 required.');
    }

    await db.query('BEGIN');
    started = true;

    // Duplicate interactions must not create another purchase.
    const previous = await db.query(
      `SELECT operation_id
       FROM cunvrs_economy_ledger
       WHERE operation_id = $1`,
      [op]
    );

    if (previous.rows.length) {
      await db.query('ROLLBACK');
      started = false;
      return { duplicate: true };
    }

    await db.query(
      `INSERT INTO guilds (id)
       VALUES ($1)
       ON CONFLICT (id) DO NOTHING`,
      [guildId]
    );

    await db.query(
      `INSERT INTO users (id)
       VALUES ($1)
       ON CONFLICT (id) DO NOTHING`,
      [userId]
    );

    await db.query(
      `INSERT INTO economy
         (guild_id, user_id, balance, bank, data)
       VALUES (
         $1, $2, 0, 0,
         '{"wallet":0,"bank":0,"level":1}'::jsonb
       )
       ON CONFLICT (guild_id, user_id) DO NOTHING`,
      [guildId, userId]
    );

    const account = await db.query(
      `SELECT balance, data
       FROM economy
       WHERE guild_id = $1 AND user_id = $2
       FOR UPDATE`,
      [guildId, userId]
    );

    const row = account.rows[0];

    if (!row) throw new Error('Account unavailable.');

    const data = row.data || {};
    const wallet = Number(row.balance);
    const savedWallet = Number(data.wallet ?? row.balance);

    if (
      !Number.isSafeInteger(wallet) ||
      wallet < 0 ||
      !Number.isSafeInteger(savedWallet) ||
      savedWallet !== wallet
    ) {
      throw new Error('Wallet consistency error.');
    }

    const inventory = inventoryFromData(data);
    const owned = Number(inventory[item.id] ?? 0);

    if (!Number.isSafeInteger(owned) || owned < 0) {
      throw new Error('Invalid item quantity.');
    }

    if (owned + quantity > item.max) {
      await db.query('ROLLBACK');
      started = false;

      return {
        error: `you can own at most ${item.max} ${item.name}(s)!`,
      };
    }

    if (wallet < cost) {
      await db.query('ROLLBACK');
      started = false;

      return {
        error: `you need ${cost.toLocaleString()} Unicoins, ` +
          `but you only have ${wallet.toLocaleString()}!`,
      };
    }

    const newWallet = wallet - cost;
    const updatedData = {
      ...data,
      wallet: newWallet,
      inventory: {
        ...inventory,
        [item.id]: owned + quantity,
      },
    };

    await db.query(
      `UPDATE economy
       SET balance = $3,
           data = $4::jsonb,
           updated_at = CURRENT_TIMESTAMP
       WHERE guild_id = $1 AND user_id = $2`,
      [
        guildId,
        userId,
        newWallet,
        JSON.stringify(updatedData),
      ]
    );

    await db.query(
      `INSERT INTO cunvrs_economy_ledger
         (
           operation_id, guild_id, user_id,
           actor_id, event_type, amount,
           balance_before, balance_after, details
         )
       VALUES (
         $1, $2, $3, $3, 'shop_purchase',
         $4, $5, $6, $7::jsonb
       )`,
      [
        op,
        guildId,
        userId,
        -cost,
        wallet,
        newWallet,
        JSON.stringify({
          itemId: item.id,
          quantity,
          unitPrice: item.price,
        }),
      ]
    );

    await db.query('COMMIT');
    started = false;

    return {
      item,
      quantity,
      cost,
      wallet: newWallet,
    };
  } catch (error) {
    if (started) {
      await db.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    db.release();
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Browse and purchase cute items with Unicoins!')
    .addSubcommand(sub =>
      sub.setName('browse')
        .setDescription('See the Unicoin shop catalog')
    )
    .addSubcommand(sub =>
      sub.setName('buy')
        .setDescription('Purchase an item from the shop')
        .addStringOption(option =>
          option.setName('item')
            .setDescription('Choose an item')
            .setRequired(true)
            .addChoices(
              ...ITEMS.map(item => ({
                name: item.name,
                value: item.id,
              }))
            )
        )
        .addIntegerOption(option =>
          option.setName('quantity')
            .setDescription('How many? (default: 1)')
            .setMinValue(1)
            .setMaxValue(10)
        )
    )
    .addSubcommand(sub =>
      sub.setName('inventory')
        .setDescription('View your purchased collectibles')
    ),

  async execute(interaction) {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral,
    });

    if (!interaction.guildId) {
      await interaction.editReply({
        content: '♡ the shop is only available in servers!',
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    try {
      if (sub === 'browse') {
        const catalog = ITEMS.map(item =>
          `**${item.name}** · \`${item.id}\`\n` +
          `${UNICOIN_EMOJI} ${item.price.toLocaleString()} Unicoins\n` +
          `♡ ${item.description}`
        ).join('\n\n');

        await interaction.editReply({
          embeds: [
            embed(
              `## 🎀 ⋮ **__unicoin shop!__**\n\n` +
              `${catalog}\n\n` +
              '♡ use `/shop buy` to purchase an item!'
            ),
          ],
        });
        return;
      }

      const pool = getPaymentPool();

      if (sub === 'inventory') {
        const result = await pool.query(
          `SELECT data
           FROM economy
           WHERE guild_id = $1 AND user_id = $2`,
          [interaction.guildId, interaction.user.id]
        );

        const inventory = inventoryFromData(
          result.rows[0]?.data ?? {}
        );

        const entries = Object.entries(inventory)
          .filter(([, quantity]) =>
            Number.isSafeInteger(Number(quantity)) &&
            Number(quantity) > 0
          )
          .map(([itemId, quantity]) => {
            const item = ITEMS.find(i => i.id === itemId);
            return `♡ **${item?.name ?? itemId}** × ${quantity}`;
          });

        await interaction.editReply({
          embeds: [
            embed(
              `## 🎀 ⋮ **__your inventory!__**\n\n` +
              (entries.join('\n') ||
                '♡ your inventory is empty!')
            ),
          ],
        });
        return;
      }

      if (sub === 'buy') {
        const result = await purchase(pool, {
          guildId: interaction.guildId,
          userId: interaction.user.id,
          interactionId: interaction.id,
          itemId: interaction.options.getString('item'),
          quantity:
            interaction.options.getInteger('quantity') ?? 1,
        });

        if (result.error || result.duplicate) {
          await interaction.editReply({
            embeds: [
              embed(
                result.duplicate
                  ? '♡ this purchase was already processed. check your inventory!'
                  : `♡ ${result.error}`
              ),
            ],
          });
          return;
        }

        await interaction.editReply({
          embeds: [
            embed(
              `## 🎀 ⋮ **__purchase complete!__**\n\n` +
              `♡ **item:** ${result.item.name}\n` +
              `♡ **quantity:** ${result.quantity}\n` +
              `${UNICOIN_EMOJI} **spent:** ${result.cost.toLocaleString()}\n` +
              `${UNICOIN_EMOJI} **wallet:** ${result.wallet.toLocaleString()}\n\n` +
              '♡ your item has been added to your inventory!'
            ),
          ],
        });
      }
    } catch (error) {
      console.error('[CUNVRS SHOP]', error);

      await interaction.editReply({
        embeds: [
          embed(
            '♡ the shop could not complete your request. ' +
            'please check your wallet and inventory before retrying.'
          ),
        ],
      }).catch(() => {});
    }
  },
};
