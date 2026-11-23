import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { withErrorHandling } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getPaymentPool } from './modules/paymentHandler.js';
import { UNICOIN_EMOJI } from '../../utils/wallet.js';

const PINK = 0xFFEDF4;
const TYPES = [
  ['ugc', 'UGC'], ['robux', 'Robux'], ['vip', 'VIP'],
];

function safeAmount(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Invalid ${label}.`);
  return n;
}

export default {
  data: new SlashCommandBuilder().setName('balance')
    .setDescription('View Unicoins and Shop Tokens')
    .setDMPermission(false)
    .addUserOption(opt => opt.setName('user')
      .setDescription('Member to look up').setRequired(false)),
  execute: withErrorHandling(async (interaction) => {
    if (!await InteractionHelper.safeDefer(interaction)) return;
    const target = interaction.options.getUser('user') ?? interaction.user;
    if (!interaction.guildId || target.bot) {
      await InteractionHelper.safeEditReply(interaction, {
        content: '♡ choose a person in a server to see their wallet.',
      });
      return;
    }
    const pool = getPaymentPool();
    // Both queries are read-only. No account, token or wallet gets created.
    const [balances,tokens] = await Promise.all([
      pool.query(`SELECT balance,data FROM economy
        WHERE guild_id=$1 AND user_id=$2`, [interaction.guildId,target.id]),
      pool.query(`SELECT ticket_type,available,reserved
        FROM cunvrs_redemption_ticket_balances
        WHERE guild_id=$1 AND user_id=$2`, [interaction.guildId,target.id]),
    ]);
    const row = balances.rows[0];
    const wallet = safeAmount(row?.data?.wallet ?? row?.balance ?? 0, 'wallet');
    // Don't silently display a conflicting wallet value.
    if (row && safeAmount(row.balance, 'database wallet') !== wallet) {
      throw new Error('Wallet data and balance disagree.');
    }
    const byType = new Map(tokens.rows.map(t=>[t.ticket_type,t]));
    const tokenLines = TYPES.map(([type,label]) => {
      const item=byType.get(type);
      const available=safeAmount(item?.available ?? 0, `${type} available`);
      const reserved=safeAmount(item?.reserved ?? 0, `${type} reserved`);
      return `♡ **${label}:** ${available} available` +
        (reserved ? ` · ${reserved} reserved` : '');
    });
    const owner = target.id===interaction.user.id ? 'your' : `${target.username}'s`;
    const embed = new EmbedBuilder().setColor(PINK)
      .setDescription(
        `## 🎀 ⋮ **__${owner} cunvrs. wallet!__**\n\n` +
        `${UNICOIN_EMOJI} **Unicoins:** ${wallet.toLocaleString('en-US')}\n\n` +
        '**୨୧ shop tokens**\n' + tokenLines.join('\n') +
        '\n\n-# shop tokens are redemption tickets, not a second currency'
      )
      .setThumbnail(target.displayAvatarURL())
      .setFooter({text:'cunvrs. economy · balance preview'});
    await InteractionHelper.safeEditReply(interaction, {
      embeds:[embed],allowedMentions:{parse:[]},
    });
  },{command:'balance'}),
};
