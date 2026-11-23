import assert from 'node:assert/strict';
import { test } from 'node:test';
import shop from '../src/commands/Economy/shop.js';
import {
  CUNVRS_SHOP_CATALOG as items,
  CUNVRS_SHOP_CATEGORIES as categories,
} from '../src/config/shop/cunvrsCatalog.js';

test('the approved catalog has 22 fixed-price rewards and one staff-quoted reward', () => {
  assert.equal(items.length, 23);
  assert.equal(new Set(items.map(item => item.id)).size, 23);
  const counts = Object.fromEntries(Object.keys(categories).map(category => [
    category, items.filter(item => item.category === category).length,
  ]));
  assert.deepEqual(counts, { ugc: 9, robux: 5, discord: 9 });
  for (const item of items) {
    assert.equal(item.enabled, item.price !== null);
    assert.ok(item.price === null || (Number.isSafeInteger(item.price) && item.price > 0));
  }
});

async function runShop(subcommand, options = {}) {
  let reply;
  await shop.execute({
    guildId: 'test-guild',
    options: {
      getSubcommand: () => subcommand,
      getString: name => options[name] ?? null,
    },
    deferReply: async () => {},
    editReply: async payload => { reply = payload; },
  });
  return reply.content ?? reply.embeds.map(embed => embed.toJSON().description).join('\n');
}

test('browse displays all rewards and can filter by category', async () => {
  const all = await runShop('browse');
  const filtered = await runShop('browse', { category: 'robux' });
  for (const item of items) {
    assert.ok(all.includes(`**${item.name}**`));
    assert.equal(filtered.includes(`**${item.name}**`), item.category === 'robux');
  }
});

test('both commands list all rewards and direct quote-only purchases to staff', async () => {
  const command = shop.data.toJSON();
  for (const [subcommand, option] of [['item', 'reward'], ['buy', 'item']]) {
    const registered = command.options.find(entry => entry.name === subcommand);
    assert.deepEqual(registered.options[0].choices.map(choice => choice.value),
      items.map(item => item.id));
  }
  const item = await runShop('item', { reward: 'premium_reward_20_plus' });
  assert.match(item, /Price requires staff review/);
  const purchase = await runShop('buy', { item: 'premium_reward_20_plus' });
  assert.match(purchase, /Ask staff for a quote/);
});

test('fixed-price purchases require a redemption ticket', async () => {
  const prior = process.env.CUNVRS_REDEMPTIONS_ENABLED;
  process.env.CUNVRS_REDEMPTIONS_ENABLED = 'true';
  try {
    const reply = await runShop('buy', { item: 'robux_50' });
    assert.match(reply, /Open a ticket/);
  } finally {
    if (prior === undefined) delete process.env.CUNVRS_REDEMPTIONS_ENABLED;
    else process.env.CUNVRS_REDEMPTIONS_ENABLED = prior;
  }
});
