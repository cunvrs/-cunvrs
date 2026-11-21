
import { SlashCommandBuilder } from 'discord.js';
import { handlePayment } from './modules/paymentHandler.js';

export default {
  data: new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Send Unicoins to another member')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('Member receiving your Unicoins')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName('amount')
        .setDescription('How many Unicoins to send')
        .setRequired(true)
        .setMinValue(1)
    ),

  async execute(interaction, config, client) {
    await handlePayment(interaction);
  },
};
