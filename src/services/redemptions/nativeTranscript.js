import { AttachmentBuilder } from 'discord.js';

const MAX_MESSAGES = 5000;
const MAX_BYTES = 7 * 1024 * 1024;

export async function buildNativeRedemptionTranscript(channel) {
  if (
    !channel?.id ||
    typeof channel.messages?.fetch !== 'function'
  ) {
    throw new Error('Invalid transcript channel.');
  }

  const messages = [];
  let before;

  while (messages.length < MAX_MESSAGES) {
    const page = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {})
    });

    const batch = [...page.values()];

    if (batch.length === 0) break;

    messages.push(...batch);

    // Discord returns messages newest first.
    before = batch.at(-1).id;

    if (batch.length < 100) break;
  }

  if (messages.length >= MAX_MESSAGES) {
    throw new Error(
      'Transcript exceeds safe message limit. Manual archival required.'
    );
  }

  messages.sort((a, b) =>
    Number(a.createdTimestamp) - Number(b.createdTimestamp)
  );

  const lines = [
    'CUNVRS. REDEMPTION TICKET TRANSCRIPT',
    `Channel ID: ${channel.id}`,
    `Channel name: ${channel.name ?? 'unknown'}`,
    `Generated: ${new Date().toISOString()}`,
    `Messages: ${messages.length}`,
    '----------------------------------------',
    ''
  ];

  for (const message of messages) {
    const time = message.createdAt instanceof Date
      ? message.createdAt.toISOString()
      : new Date(message.createdTimestamp).toISOString();

    const author = message.author?.username ?? 'Unknown';
    const authorId = message.author?.id ?? 'unknown';

    lines.push(
      `[${time}] ${author} (${authorId})`,
      `Message ID: ${message.id}`,
      message.content || '[no text content]'
    );

    for (const attachment of message.attachments?.values() ?? []) {
      lines.push(
        `Attachment: ${attachment.name ?? 'file'} | ${attachment.url}`
      );
    }

    for (const embed of message.embeds ?? []) {
      if (embed.title) lines.push(`Embed title: ${embed.title}`);
      if (embed.description) {
        lines.push(`Embed description: ${embed.description}`);
      }
    }

    lines.push('');
  }

  const content = lines.join('\n');
  const buffer = Buffer.from(content, 'utf8');

  if (buffer.length > MAX_BYTES) {
    throw new Error(
      'Transcript is too large. Manual archival required.'
    );
  }

  return {
    attachment: new AttachmentBuilder(buffer, {
      name: `cunvrs-redemption-${channel.id}.txt`
    }),
    messageCount: messages.length,
    byteCount: buffer.length,
    content
  };
}
