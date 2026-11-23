import {
  ActionRowBuilder,
  StringSelectMenuBuilder
} from 'discord.js';

const VALID_ACTIONS = Object.freeze({
  approve: ['pending_approval'],
  decline: ['pending_approval', 'approved'],
  deliver: ['approved', 'in_progress']
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const REDEMPTION_SELECT_PREFIX =
  'cunvrs_redemption_select_';

export function buildNativeRedemptionSelect(action, rows) {
  const allowedStatuses = VALID_ACTIONS[action];

  if (!allowedStatuses) {
    throw new Error('Invalid redemption selection action.');
  }

  if (!Array.isArray(rows) || rows.length > 25) {
    throw new Error('Invalid redemption selection results.');
  }

  if (!rows.length) {
    return {
      content: '♡ no eligible redemption requests found in this ticket!',
      components: [],
      allowedMentions: { parse: [] }
    };
  }

  const options = rows.map(row => {
    if (
      !UUID_PATTERN.test(row.id) ||
      !allowedStatuses.includes(row.status)
    ) {
      throw new Error('Invalid redemption selection record.');
    }

    const item = String(row.item_name ?? row.item_code ?? 'reward')
      .replace(/[\r\n]/g, ' ')
      .slice(0, 55);

    const amount = Number(row.coins_reserved);

    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error('Invalid redemption price.');
    }

    return {
      label: `${item || 'reward'} - ${row.status}`.slice(0, 100),
      description: `${amount.toLocaleString('en-US')} Unicoins - ID ${row.id.slice(0, 8)}`,
      value: row.id
    };
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${REDEMPTION_SELECT_PREFIX}${action}`)
    .setPlaceholder(`Choose a request to ${action}`)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return {
    content:
      `## 🎀 ⋮ select a redemption!\n\n` +
      `♡ choose the request you'd like to **${action}**.\n` +
      `-# only eligible requests from this ticket are listed.`,
    components: [
      new ActionRowBuilder().addComponents(select)
    ],
    allowedMentions: { parse: [] }
  };
}
