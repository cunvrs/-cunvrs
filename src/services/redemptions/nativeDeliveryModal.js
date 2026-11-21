import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DELIVERY_MODAL_PREFIX =
  'cunvrs_redemption_delivery_modal_';

export const DELIVERY_EVIDENCE_ID =
  'cunvrs_redemption_delivery_evidence';

export function buildNativeDeliveryModal(redemptionId) {
  if (
    typeof redemptionId !== 'string' ||
    !UUID.test(redemptionId)
  ) {
    throw new Error('Invalid delivery redemption ID.');
  }

  const evidence = new TextInputBuilder()
    .setCustomId(DELIVERY_EVIDENCE_ID)
    .setLabel('Fulfillment evidence')
    .setPlaceholder('Roblox item link or fulfillment reference')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(8)
    .setMaxLength(500);

  return new ModalBuilder()
    .setCustomId(
      `${DELIVERY_MODAL_PREFIX}${redemptionId}`
    )
    .setTitle('cunvrs. | Confirm Delivery')
    .addComponents(
      new ActionRowBuilder().addComponents(evidence)
    );
}
