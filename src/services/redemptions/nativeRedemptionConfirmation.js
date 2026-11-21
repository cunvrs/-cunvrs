import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';

const ACTIONS = new Set(['approve', 'decline']);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const REDEMPTION_CONFIRM_PREFIX =
  'cunvrs_redemption_confirm_';

export const REDEMPTION_CANCEL_ID =
  'cunvrs_redemption_cancel';

export function buildNativeRedemptionConfirmation(action, record) {
  if (!ACTIONS.has(action)) {
    throw new Error('Invalid confirmation action.');
  }

  if (
    typeof record?.id !== 'string' ||
    !UUID_PATTERN.test(record.id)
  ) {
    throw new Error('Invalid confirmation redemption ID.');
  }

  const eligible =
    action === 'approve'
      ? ['pending_approval']
      : ['pending_approval', 'approved'];

  if (!eligible.includes(record.status)) {
    throw new Error('Redemption is not eligible for this action.');
  }

  const amount = Number(record.coins_reserved);

  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error('Invalid redemption amount.');
  }

  const reward = String(record.item_code ?? 'reward')
    .replace(/[`*_~|<>\r\n@]/g, '')
    .slice(0, 60) || 'reward';

  const confirm = new ButtonBuilder()
    .setCustomId(
      `${REDEMPTION_CONFIRM_PREFIX}${action}_${record.id}`
    )
    .setLabel(`Confirm ${action}`)
    .setStyle(
      action === 'decline'
        ? ButtonStyle.Danger
        : ButtonStyle.Success
    );

  const cancel = new ButtonBuilder()
    .setCustomId(REDEMPTION_CANCEL_ID)
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Secondary);

  return {
    content:
      '## 🎀 ⋮ __confirm redemption!__\n\n' +
      `♡ **action:** ${action}\n` +
      `♡ **reward:** ${reward}\n` +
      `♡ **status:** ${record.status}\n` +
      `♡ **amount:** ${amount.toLocaleString('en-US')} <:unicoin:1573337526716997773>\n` +
      `♡ **request ID:** \`${record.id}\`\n\n` +
      '⚠️ **This action requires confirmation.**\n' +
      '-# The request must be revalidated before processing.',
    components: [
      new ActionRowBuilder().addComponents(confirm, cancel)
    ],
    allowedMentions: { parse: [] }
  };
}
