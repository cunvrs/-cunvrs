import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import balance from '../src/commands/Economy/balance.js';

async function runBalance(t, walletRows, tokenRows) {
  const query = t.mock.method(pg.Pool.prototype, 'query', async (sql, params) => {
    assert.deepEqual(params, ['test-guild', 'test-user']);
    assert.match(sql, /^SELECT\b/);
    return { rows: sql.includes('FROM economy') ? walletRows : tokenRows };
  });
  const user = { id: 'test-user', displayAvatarURL: () => 'https://example.com/avatar.png' };
  let response;
  await balance.execute({
    id: 'test-interaction',
    guildId: 'test-guild',
    user,
    options: { getUser: () => null },
    createdTimestamp: Date.now(),
    deferred: true,
    editReply: async payload => { response = payload; },
  });
  assert.equal(query.mock.callCount(), 2);
  return response.embeds[0].toJSON().description;
}

test('balance shows the wallet and available and reserved shop tokens', async t => {
  const reply = await runBalance(t, [{ balance: '1234', data: { wallet: 1234 } }], [
    { ticket_type: 'ugc', available: 2, reserved: 1 },
    { ticket_type: 'vip', available: 3, reserved: 0 },
  ]);
  assert.match(reply, /Unicoins:\*\* 1,234/);
  assert.match(reply, /UGC:\*\* 2 available · 1 reserved/);
  assert.match(reply, /Robux:\*\* 0 available/);
  assert.match(reply, /VIP:\*\* 3 available/);
});

test('balance displays zeros for a member without an account', async t => {
  const reply = await runBalance(t, [], []);
  assert.match(reply, /Unicoins:\*\* 0/);
  assert.equal((reply.match(/0 available/g) ?? []).length, 3);
});
