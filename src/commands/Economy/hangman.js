import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { randomInt, randomUUID } from 'node:crypto';
import { getPaymentPool } from './modules/paymentHandler.js';
import { getGameCooldown, settleMinigame } from './modules/gameRewardService.js';
import { UNICOIN_EMOJI } from '../../utils/wallet.js';

const WORDS = ['NECKLACE','DIAMOND','CUPCAKE','BUTTERFLY','FLOWER','STRAWBERRY','BRACELET','SUNSHINE'];
const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const embed = text => new EmbedBuilder().setColor(0xFFEDF4)
  .setDescription(`## 🎀 ⋮ **__hangman!__**\n\n${text}`).setFooter({text:'cunvrs. minigames'});
function render(word, guessed, misses) {
  const display=[...word].map(c=>guessed.has(c)?c:'＿').join(' ');
  return `♡ word: **${display}**\n♡ incorrect guesses: **${misses}/6**\n`+
    `♡ used letters: ${[...guessed].join(', ')||'none'}\n\nChoose a letter below (30 seconds per guess).`;
}
function menus(session, guessed) {
  return [ALPHABET.slice(0,13), ALPHABET.slice(13)].map((letters,index)=>{
    const available=[...letters].filter(c=>!guessed.has(c));
    if (!available.length) return null;
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`ch:${session}:${index}`)
      .setPlaceholder(index?'Letters N–Z':'Letters A–M')
      .addOptions(available.map(c=>({label:c,value:c}))));
  }).filter(Boolean);
}
export default {
  data:new SlashCommandBuilder().setName('hangman').setDescription('Guess letters to save the word!'),
  async execute(interaction) {
    await interaction.deferReply({ephemeral:true});
    if (!interaction.guildId) return interaction.editReply({content:'♡ play inside a server!'});
    try {
      const pool=getPaymentPool();
      const ids={guildId:interaction.guildId,userId:interaction.user.id,game:'hangman'};
      const status=await getGameCooldown(pool,ids);
      if(status.cooldown) return interaction.editReply({embeds:[embed(`♡ play again <t:${Math.ceil(status.nextPlay/1000)}:R>`)]});
      const word=WORDS[randomInt(WORDS.length)];
      const guessed=new Set();
      const session=randomUUID().slice(0,12);
      let misses=0, timedOut=false;
      while(misses<6 && [...word].some(c=>!guessed.has(c))) {
        const message=await interaction.editReply({embeds:[embed(render(word,guessed,misses))],components:menus(session,guessed)});
        let clicked;
        try {
          clicked=await message.awaitMessageComponent({time:30_000,
            filter:i=>i.user.id===interaction.user.id&&i.customId.startsWith(`ch:${session}:`)});
        } catch { timedOut=true; break; }
        const letter=clicked.values?.[0];
        await clicked.deferUpdate();
        if (!letter || !ALPHABET.includes(letter) || guessed.has(letter)) continue;
        guessed.add(letter);
        if(!word.includes(letter)) misses++;
      }
      const won=!timedOut && [...word].every(c=>guessed.has(c));
      const result=await settleMinigame(pool,{...ids,interactionId:interaction.id,won});
      if(result.cooldown) return interaction.editReply({embeds:[embed(`♡ game already completed. try again <t:${Math.ceil(result.nextPlay/1000)}:R>`)],components:[]});
      await interaction.editReply({embeds:[embed(`${won?'🎀 you saved the word!':timedOut?'♡ time ran out!':'♡ game over!'}\n`+
        `♡ word: **${word}**\n`+
        `${UNICOIN_EMOJI} earned: **${result.earned}**\n`+
        `✨ XP: **+${result.xpEarned}**\n`+
        `♡ wallet: **${result.wallet.toLocaleString()}**\n`+
        `♡ games today: **${result.dailyMinigameCoins}/1,500**\n`+
        `♡ next hangman: <t:${Math.ceil(result.nextPlay/1000)}:R>`)],components:[]});
    } catch(error) {
      console.error('[CUNVRS HANGMAN]',error);
      await interaction.editReply({embeds:[embed('♡ game result could not be confirmed. check your balance before trying again.')],components:[]}).catch(()=>{});
    }
  },
};
