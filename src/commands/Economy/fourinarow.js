import { SlashCommandBuilder } from 'discord.js';
import { playBoardGame } from './modules/boardGames.js';

export default {
  data: new SlashCommandBuilder().setName('fourinarow')
    .setDescription('Challenge a member to four in a row!')
    .addUserOption(option => option.setName('opponent')
      .setDescription('Who do you want to challenge?').setRequired(true)),
  execute(interaction) {
    return playBoardGame(interaction, 'fourinarow');
  },
};
