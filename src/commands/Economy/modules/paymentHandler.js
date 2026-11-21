
import pg from 'pg';
import { createHash } from 'node:crypto';
import { EmbedBuilder } from 'discord.js';
import { resolvePostgresPoolConfig } from '../../../config/database/postgres.js';
import {
  transferUnicoins,
  formatUnicoins,
  UNICOIN_EMOJI,
} from '../../../utils/wallet.js';

const PINK = 0xFFEDF4;
let paymentPool;

export function getPaymentPool() {
  if (!paymentPool) {
    paymentPool = new pg.Pool(resolvePostgresPoolConfig());
    paymentPool.on('error', (error) => {
      console.error('[PAYMENT POOL]', error.message);
    });
  }
  return paymentPool;
}

// The same Discord interaction always produces the same UUID.
// This prevents a retried interaction from paying twice.
function paymentOperationId(interactionId) {
  const bytes = createHash('sha256')
    .update(`cunvrs:payment:${interactionId}`)
    .digest()
    .subarray(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export async function handlePayment(interaction) {
  await interaction.deferReply();

  const pool = getPaymentPool();
  const sender = interaction.user;
  const receiver = interaction.options.getUser('user');
  const amount = interaction.options.getInteger('amount');

  try {
    if (!interaction.guildId) {
      throw new Error('This command can only be used in a server.');
    }

    if (!receiver || receiver.bot) {
      throw new Error('You cannot send Unicoins to bots.');
    }

    if (receiver.id === sender.id) {
      throw new Error('You cannot send Unicoins to yourself.');
    }

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error('Enter a valid Unicoin amount.');
    }

    // Fail closed until the economy foundation is installed.
    const version = await pool.query(
      `SELECT MAX(version) AS version FROM schema_migrations`
    );

    if (Number(version.rows[0]?.version) !== 2) {
      throw new Error(
        'Unicoin transfers are unavailable until the economy upgrade is complete.'
      );
    }

    const result = await transferUnicoins(pool, {
      guildId: interaction.guildId,
      fromUserId: sender.id,
      toUserId: receiver.id,
      amount,
      operationId: paymentOperationId(interaction.id),
    });

    const embed = new EmbedBuilder()
      .setColor(PINK)
      .setDescription(
        `## ${UNICOIN_EMOJI} ⋮ **__payment sent!__**\n\n` +
        `**you gave ${receiver} ${formatUnicoins(amount)}!**\n\n` +
        `${UNICOIN_EMOJI} **remaining balance:** ` +
        `${result.senderBalance.toLocaleString('en-US')}`
      )
      .setFooter({ text: 'cunvrs. economy' })
      .setTimestamp();

    await interaction.editReply({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });

    // A failed DM must never reverse a successful payment.
    try {
      const notification = new EmbedBuilder()
        .setColor(PINK)
        .setDescription(
          `## ${UNICOIN_EMOJI} ⋮ **__payment received!__**\n\n` +
          `**${sender.username} sent you ${formatUnicoins(amount)}!**\n\n` +
          `${UNICOIN_EMOJI} **new balance:** ` +
          result.receiverBalance.toLocaleString('en-US')
        );

      await receiver.send({ embeds: [notification] });
    } catch {
      // Users can disable direct messages.
    }
  } catch (error) {
    console.error('[UNICOIN PAYMENT]', error.message);

    const friendlyErrors = [
      'Not enough Unicoins',
      'cannot send',
      'cannot only',
      'cannot be used',
      'Enter a valid',
      'unavailable until',
    ];

    const message = friendlyErrors.some((text) =>
      error.message.toLowerCase().includes(text.toLowerCase())
    )
      ? error.message
      : 'Your payment could not be completed. No new payment was confirmed.';

    const embed = new EmbedBuilder()
      .setColor(PINK)
      .setDescription(
        `## ${UNICOIN_EMOJI} ⋮ **__payment unsuccessful!__**\n\n` +
        message
      );

    await interaction.editReply({ embeds: [embed] });
  }
}
