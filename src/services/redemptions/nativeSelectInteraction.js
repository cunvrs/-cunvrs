import { MessageFlags } from 'discord.js';
import { buildNativeRedemptionConfirmation } from './nativeRedemptionConfirmation.js';

import {
  REDEMPTION_SELECT_PREFIX
} from './nativeRedemptionSelectMenu.js';

import {
  listNativeTicketRedemptions
} from './nativeRedemptionSelection.js';

const ACTIONS = new Set([
  'approve',
  'decline',
  'deliver'
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleNativeRedemptionSelection(
  interaction,
  options = {}
) {
  const customId = interaction.customId;

  if (
    typeof customId !== 'string' ||
    !customId.startsWith(REDEMPTION_SELECT_PREFIX)
  ) {
    return false;
  }

  await interaction.deferReply();

  try {
    const action = customId.slice(
      REDEMPTION_SELECT_PREFIX.length
    );

    if (!ACTIONS.has(action)) {
      throw new Error('Unknown selection action.');
    }

    const selectedId = interaction.values?.[0];

    if (
      interaction.values?.length !== 1 ||
      typeof selectedId !== 'string' ||
      !UUID_PATTERN.test(selectedId)
    ) {
      throw new Error('Invalid selected redemption ID.');
    }

    const requests = await listNativeTicketRedemptions(
      interaction,
      action,
      options
    );

    const record = requests.find(
      request => request.id === selectedId
    );

    if (!record) {
      throw new Error(
        'Selected redemption is no longer eligible in this ticket.'
      );
    }

    // CUNVRS_SELECTION_CONFIRMATION_V2
    // Display confirmation only. No wallet changes occur here.
    if (action === 'approve' || action === 'decline') {
      await interaction.editReply(
        buildNativeRedemptionConfirmation(action, record)
      );
      return true;
    }

    const safeItem = String(record.item_code ?? 'reward')
      .replace(/[`*_~|<>\r\n]/g, '')
      .slice(0, 60);

    const amount = Number(record.coins_reserved);

    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error('Invalid redemption price.');
    }

    await interaction.editReply({
      content:
        '## 🎀 ⋮ redemption selected!\n\n' +
        `♡ **action:** ${action}\n` +
        `♡ **reward:** ${safeItem || 'reward'}\n` +
        `♡ **status:** ${record.status}\n` +
        `♡ **amount:** ${amount.toLocaleString('en-US')} Unicoins\n` +
        `♡ **request:** \`${record.id}\`\n\n` +
        '-# Selection verified. No changes have been made.',
      components: [],
      allowedMentions: { parse: [] }
    });

  } catch (error) {
    console.error(
      '[native redemption selection]',
      error.message
    );

    await interaction.editReply({
      content:
        '♡ this request could not be verified. ' +
        'Please reopen the dropdown and try again.',
      components: [],
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }

  return true;
}
