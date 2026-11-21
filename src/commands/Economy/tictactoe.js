import { SlashCommandBuilder } from 'discord.js';
import { playBoardGame } from './modules/boardGames.js';

export default {
  data: new SlashCommandBuilder().setName('tictactoe')
    .setDescription('Challenge a member to tic-tac-toe for Unicoins!')
    .addUserOption(option => option.setName('opponent')
      .setDescription('Who do you want to challenge?').setRequired(true)),
  execute(interaction) {
    return playBoardGame(interaction, 'tictactoe');
  },
};
