
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { withErrorHandling } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getPaymentPool } from './modules/paymentHandler.js';
import { UNICOIN_EMOJI } from '../../utils/wallet.js';

const PINK = 0xFFEDF4;

export default {
  data: new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check your or another member’s Unicoin balance')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('Member whose balance you want to see')
        .setRequired(false)
    ),

  execute: withErrorHandling(async (interaction, config, client) => {
    const deferred = await InteractionHelper.safeDefer(interaction);
    if (!deferred) return;

    const targetUser =
      interaction.options.getUser('user') || interaction.user;

    if (targetUser.bot) {
      await InteractionHelper.safeEditReply(interaction, {
        content: 'Bots do not have Unicoin wallets.',
      });
      return;
    }

    if (!interaction.guildId) {
      await InteractionHelper.safeEditReply(interaction, {
        content: 'This command can only be used in a server.',
      });
      return;
    }

    const pool = getPaymentPool();

    // Read the existing wallet without creating or changing an account.
    // PostgreSQL errors are not treated as empty wallets.
    const result = await pool.query(
      `SELECT balance, data
       FROM economy
       WHERE guild_id = $1 AND user_id = $2`,
      [interaction.guildId, targetUser.id]
    );

    let wallet = 0;

    if (result.rows.length > 0) {
      const row = result.rows[0];

      // Existing economy records may store wallet data in JSONB.
      const rawBalance = row.data?.wallet ?? row.balance ?? 0;
      wallet = Number(rawBalance);

      if (!Number.isSafeInteger(wallet) || wallet < 0) {
        throw new Error('Invalid wallet balance in database.');
      }
    }

    const isOwnBalance = targetUser.id === interaction.user.id;

    const embed = new EmbedBuilder()
      .setColor(PINK)
      .setDescription(
        `## ${UNICOIN_EMOJI} ⋮ **__${isOwnBalance ? 'your balance!' : 'unicoin balance!'}__**\n\n` +
        `**${targetUser}**\n\n` +
        `${UNICOIN_EMOJI} **wallet:** ${wallet.toLocaleString('en-US')}`
      )
      .setThumbnail(targetUser.displayAvatarURL())
      .setFooter({ text: 'cunvrs. economy' })
      .setTimestamp();

    await InteractionHelper.safeEditReply(interaction, {
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
  }, { command: 'balance' }),
};
