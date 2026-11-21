import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { getGameCooldown, settleMinigame } from './gameRewardService.js';
import { getPaymentPool } from './paymentHandler.js';
import { UNICOIN_EMOJI } from '../../../utils/wallet.js';

// One active multiplayer match per member within this bot process.
// The database cooldown checks and settlement locks are the final reward safeguards.
const busy = new Set();
const GAME = {
  tictactoe: { name: 'tic-tac-toe', icon: '⭕', maxTurns: 9, reward: 75 },
  fourinarow: { name: 'four in a row', icon: '💗', maxTurns: 42, reward: 150 },
};
const COLORS = ['🔴', '🟡'];

function boardEmbed(game, text) {
  return new EmbedBuilder().setColor(0xFFEDF4)
    .setDescription(`## ${GAME[game].icon} ⋮ **__${GAME[game].name}!__**\n\n${text}`)
    .setFooter({ text: 'cunvrs. minigames' });
}
export function line3(cells, player) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
  return lines.some(line => line.every(i => cells[i] === player));
}
export function line4(board, player) {
  for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) {
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      if (Array.from({ length: 4 }, (_, i) => [r + i * dr, c + i * dc])
        .every(([rr, cc]) => rr >= 0 && rr < 6 && cc >= 0 && cc < 7 && board[rr][cc] === player)) {
        return true;
      }
    }
  }
  return false;
}
function renderTic(cells, session) {
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c;
      const mark = cells[i];
      row.addComponents(new ButtonBuilder().setCustomId(`cb_${session}_${i}`)
        .setLabel(mark === -1 ? '·' : mark === 0 ? 'X' : 'O')
        .setStyle(mark === -1 ? ButtonStyle.Secondary : mark === 0 ? ButtonStyle.Primary : ButtonStyle.Danger)
        .setDisabled(mark !== -1));
    }
    rows.push(row);
  }
  return rows;
}
function renderFour(board, session) {
  const first = new ActionRowBuilder();
  const second = new ActionRowBuilder();
  for (let c = 0; c < 7; c++) {
    const button = new ButtonBuilder().setCustomId(`cb_${session}_${c}`)
      .setLabel(`${c + 1}`).setStyle(ButtonStyle.Secondary)
      .setDisabled(board[0][c] !== -1);
    (c < 4 ? first : second).addComponents(button);
  }
  return [first, second];
}
function describeFour(board) {
  return board.map(row => row.map(x => x === -1 ? '⚪' : COLORS[x]).join('')).join('\n') +
    '\n1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣';
}

export async function playBoardGame(interaction, game) {
  if (!Object.hasOwn(GAME, game)) throw new Error('Unknown board game.');
  await interaction.deferReply();
  if (!interaction.guildId) return interaction.editReply({ content: '♡ play inside a server!' });
  const challenger = interaction.user;
  const opponent = interaction.options.getUser('opponent');
  if (!opponent || opponent.bot || opponent.id === challenger.id) {
    return interaction.editReply({ embeds: [boardEmbed(game, '♡ choose another real member to challenge!')] });
  }
  const keys = [challenger.id, opponent.id].map(id => `${interaction.guildId}:${id}`);
  if (keys.some(key => busy.has(key))) {
    return interaction.editReply({ embeds: [boardEmbed(game, '♡ one of you is already playing a board game!')] });
  }
  keys.forEach(key => busy.add(key));
  let message;
  try {
    const pool = getPaymentPool();
    for (const user of [challenger, opponent]) {
      const state = await getGameCooldown(pool, { guildId: interaction.guildId, userId: user.id, game });
      if (state.cooldown) {
        return interaction.editReply({ embeds: [boardEmbed(game,
          `♡ <@${user.id}> is on cooldown until <t:${Math.ceil(state.nextPlay / 1000)}:R>.`)] });
      }
    }
    const session = randomUUID().slice(0, 12);
    const acceptId = `invite_${session}_yes`;
    const declineId = `invite_${session}_no`;
    message = await interaction.editReply({
      embeds: [boardEmbed(game, `<@${opponent.id}>, <@${challenger.id}> challenged you!\n♡ Accept within 30 seconds.`)],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(acceptId).setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(declineId).setLabel('Decline').setStyle(ButtonStyle.Danger),
      )],
    });
    let invite;
    try {
      invite = await message.awaitMessageComponent({
        time: 30_000,
        filter: i => i.user.id === opponent.id && [acceptId, declineId].includes(i.customId),
      });
    } catch {
      await interaction.editReply({ embeds: [boardEmbed(game, '♡ challenge expired.')], components: [] });
      return;
    }
    await invite.deferUpdate();
    if (invite.customId === declineId) {
      await interaction.editReply({ embeds: [boardEmbed(game, '♡ challenge declined.')], components: [] });
      return;
    }
    const players = [challenger, opponent];
    const cells = Array(9).fill(-1);
    const board = Array.from({ length: 6 }, () => Array(7).fill(-1));
    let winner = -1;
    let current = 0;
    let timedOut = false;
    let deadlineTurn = -1;
    let turnDeadline = 0;

for (let turn = 0; turn < GAME[game].maxTurns; turn++) {
      const components = game === 'tictactoe'
        ? renderTic(cells, session) : renderFour(board, session);
      const view = game === 'tictactoe'
        ? '♡ X vs O · click an empty square'
        : `${describeFour(board)}\n\n♡ click a column to drop your piece`;
      message = await interaction.editReply({
        embeds: [boardEmbed(game, `<@${challenger.id}> vs <@${opponent.id}>\n\n${view}\n\n` +
          `🎀 **<@${players[current].id}>'s turn** (${game === 'tictactoe' ? (current === 0 ? 'X' : 'O') : COLORS[current]})\n` +
          '♡ 60 seconds per turn')],
        components,
      });
if (deadlineTurn !== turn) {
  deadlineTurn = turn;
  turnDeadline = Date.now() + 60_000;
}

let move;
try {
  move = await message.awaitMessageComponent({
   time: Math.max(1, turnDeadline - Date.now()),
          filter: i => i.customId.startsWith(`cb_${session}_`) &&
            players.some(user => user.id === i.user.id),
        });
      } catch {
        timedOut = true;
        break;
      }
      if (move.user.id !== players[current].id) {
        await move.reply({ content: '♡ wait for your turn!', ephemeral: true }).catch(() => {});
        turn--;
        continue;
      }
      const position = Number(move.customId.split('_').at(-1));
      if (!Number.isInteger(position)) {
        await move.deferUpdate();
        turn--;
        continue;
      }
      if (game === 'tictactoe') {
        if (position < 0 || position > 8 || cells[position] !== -1) {
          await move.deferUpdate(); turn--; continue;
        }
        cells[position] = current;
        if (line3(cells, current)) winner = current;
      } else {
        if (position < 0 || position > 6) { await move.deferUpdate(); turn--; continue; }
        let row = -1;
        for (let r = 5; r >= 0; r--) if (board[r][position] === -1) { row = r; break; }
        if (row === -1) { await move.deferUpdate(); turn--; continue; }
        board[row][position] = current;
        if (line4(board, current)) winner = current;
      }
      await move.deferUpdate();
      if (winner !== -1) break;
      current = 1 - current;
    }
    // A timeout or draw awards zero coins. A normal win rewards the winner only.
    const payout = [];
    for (let p = 0; p < 2; p++) {
      payout[p] = await settleMinigame(pool, {
        guildId: interaction.guildId,
        userId: players[p].id,
        interactionId: `${interaction.id.slice(0, -1)}${p}`,
        game,
        won: !timedOut && winner === p,
      });
    }
    const boardText = game === 'tictactoe'
      ? [0, 3, 6].map(start => cells.slice(start, start + 3)
        .map(mark => mark === -1 ? '▫️' : mark === 0 ? '❌' : '⭕').join('')).join('\n')
      : describeFour(board);
    const outcome = timedOut ? '♡ game timed out — no winner rewards.'
      : winner === -1 ? '♡ it is a draw!' : `🎀 **<@${players[winner].id}> wins!**`;
    const paid = payout.filter(item => !item.cooldown).reduce((sum, item) => sum + item.earned, 0);
    await interaction.editReply({
      embeds: [boardEmbed(game, `${boardText}\n\n${outcome}\n` +
        `${UNICOIN_EMOJI} winner's reward: **${paid}**\n` +
        '♡ both players now have a game cooldown.')],
      components: [],
    });
  } catch (error) {
    console.error(`[CUNVRS ${game.toUpperCase()}]`, error);
    await interaction.editReply({
      embeds: [boardEmbed(game, '♡ match could not be confirmed. Check your balance before playing again.')],
      components: [],
    }).catch(() => {});
  } finally {
    keys.forEach(key => busy.delete(key));
  }
}
