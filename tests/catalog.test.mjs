import assert from 'node:assert/strict';
import { test } from 'node:test';
import shop from '../src/commands/Economy/shop.js';
import {
  CUNVRS_SHOP_CATALOG as items,
  CUNVRS_SHOP_CATEGORIES as categories,
} from '../src/config/shop/cunvrsCatalog.js';

test('the preview catalog contains 23 unique rewards pending approval', () => {
  assert.equal(items.length, 23);
  assert.equal(new Set(items.map(item => item.id)).size, 23);
  const counts = Object.fromEntries(Object.keys(categories).map(category => [
    category, items.filter(item => item.category === category).length,
  ]));
  assert.deepEqual(counts, { ugc: 9, robux: 5, discord: 9 });
  for (const item of items) {
    assert.equal(item.enabled, false);
    assert.equal(item.requiredToken, null);
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
  return reply.embeds.map(embed => embed.toJSON().description).join('\n');
}

test('browse displays all rewards and can filter by category', async () => {
  const all = await runShop('browse');
  const filtered = await runShop('browse', { category: 'robux' });
  for (const item of items) {
    assert.ok(all.includes(`**${item.name}**`));
    assert.equal(filtered.includes(`**${item.name}**`), item.category === 'robux');
  }
});

test('registered item and buy options lead to read-only preview replies', async () => {
  const command = shop.data.toJSON();
  for (const [subcommand, option] of [['item', 'reward'], ['buy', 'item']]) {
    const registered = command.options.find(entry => entry.name === subcommand);
    assert.deepEqual(registered.options[0].choices.map(choice => choice.value),
      items.map(item => item.id));
    const reply = await runShop(subcommand, { [option]: 'premium_reward_20_plus' });
    assert.match(reply, /Price requires staff review/);
    assert.match(reply, /awaiting approval/);
  }
});
