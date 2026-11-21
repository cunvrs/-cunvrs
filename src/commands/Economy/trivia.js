import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { randomInt, randomUUID } from 'node:crypto';
import { getPaymentPool } from './modules/paymentHandler.js';
import { getGameCooldown, settleMinigame } from './modules/gameRewardService.js';
import { UNICOIN_EMOJI } from '../../utils/wallet.js';

const QUESTIONS = [
  { q:'What is 9 × 7?', a:['56','63','72','81'], correct:1 },
  { q:'Which planet is known as the Red Planet?', a:['Mars','Venus','Jupiter','Saturn'], correct:0 },
  { q:'Which color results from mixing blue and yellow paint?', a:['Orange','Purple','Green','Pink'], correct:2 },
  { q:'How many sides does a hexagon have?', a:['5','6','7','8'], correct:1 },
  { q:'Which ocean is the largest?', a:['Atlantic','Indian','Arctic','Pacific'], correct:3 },
  { q:'How many minutes are in two hours?', a:['90','100','120','150'], correct:2 },
];
const embed = text => new EmbedBuilder().setColor(0xFFEDF4)
  .setDescription(`## 🎀 ⋮ **__trivia!__**\n\n${text}`).setFooter({text:'cunvrs. minigames'});

export default {
  data: new SlashCommandBuilder().setName('trivia').setDescription('Answer a trivia question to earn Unicoins!'),
  async execute(interaction) {
    await interaction.deferReply({ephemeral:true});
    if (!interaction.guildId) return interaction.editReply({content:'♡ play inside a server!'});
    try {
      const pool=getPaymentPool();
      const ids={guildId:interaction.guildId,userId:interaction.user.id,game:'trivia'};
      const status=await getGameCooldown(pool,ids);
      if (status.cooldown) return interaction.editReply({embeds:[embed(`♡ play again <t:${Math.ceil(status.nextPlay/1000)}:R>`)]});
      const question=QUESTIONS[randomInt(QUESTIONS.length)];
      const session=randomUUID().slice(0,12);
      const row=new ActionRowBuilder().addComponents(question.a.map((answer,i) =>
        new ButtonBuilder().setCustomId(`ct:${session}:${i}`).setLabel(answer).setStyle(ButtonStyle.Secondary)));
      const message=await interaction.editReply({embeds:[embed(`${question.q}\n\n♡ choose within 30 seconds!`)],components:[row]});
      let won=false;
      try {
        const clicked=await message.awaitMessageComponent({time:30_000,
          filter:i=>i.user.id===interaction.user.id&&i.customId.startsWith(`ct:${session}:`)});
        won=Number(clicked.customId.split(':')[2])===question.correct;
        await clicked.deferUpdate();
      } catch {
        await interaction.editReply({embeds:[embed('♡ time ran out! no reward was earned.')],components:[]});
        return;
      }
      const result=await settleMinigame(pool,{...ids,interactionId:interaction.id,won});
      if (result.cooldown) return interaction.editReply({embeds:[embed(`♡ this game was already completed. play again <t:${Math.ceil(result.nextPlay/1000)}:R>`.trim())],components:[]});
      await interaction.editReply({embeds:[embed(`${won?'🎀 correct answer!':'♡ not quite!'}\n`+
        `♡ answer: **${question.a[question.correct]}**\n`+
        `${UNICOIN_EMOJI} earned: **${result.earned}**\n`+
        `✨ XP: **+${result.xpEarned}**\n`+
        `♡ wallet: **${result.wallet.toLocaleString()}**\n`+
        `♡ games today: **${result.dailyMinigameCoins}/1,500**\n`+
        `♡ next trivia: <t:${Math.ceil(result.nextPlay/1000)}:R>`)],components:[]});
    } catch(error) {
      console.error('[CUNVRS TRIVIA]',error);
      await interaction.editReply({embeds:[embed('♡ game result could not be confirmed. check your balance before trying again.')],components:[]}).catch(()=>{});
    }
  },
};
