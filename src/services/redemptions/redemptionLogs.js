const LOG_CHANNEL_ID = '1573395941510225950';

export async function sendRedemptionLog(interaction, event) {
  try {
    const channel = await interaction.client.channels.fetch(
      LOG_CHANNEL_ID
    );

    if (
      !channel ||
      channel.guildId !== interaction.guildId ||
      typeof channel.send !== 'function'
    ) {
      throw new Error('Private log channel unavailable.');
    }

    const lines = [
      '**cunvrs. redemption audit**',
      '**Action:** ' + event.action,
      '**Actor:** <@' + interaction.user.id + '>',
      '**Member:** <@' + event.userId + '>',
      '**Ticket:** <#' + interaction.channelId + '>',
      '**Time:** ' + new Date().toISOString()
    ];

    if (event.redemptionId) {
      lines.push('**Request:** ' + event.redemptionId);
    }

    if (event.reward) {
      lines.push('**Reward:** ' + event.reward);
    }

    if (event.amount !== undefined) {
      lines.push('**Unicoins:** ' + event.amount);
    }

    await channel.send({
      content: lines.join('\n'),
      allowedMentions: { parse: [] }
    });

    return true;
  } catch (error) {
    console.error('[redemption log failure]', error);
    return false;
  }
}
