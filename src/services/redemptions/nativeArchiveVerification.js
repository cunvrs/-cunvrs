const ID = /^\d{15,22}$/;
const MARKER = 'CUNVRS_NATIVE_ARCHIVE_ONLY_V1';

export function verifyNativeArchiveMessage({
  message,
  botId,
  channelId,
  archiveMessageId
}) {
  if (
    !ID.test(botId ?? '') ||
    !ID.test(channelId ?? '') ||
    !ID.test(archiveMessageId ?? '')
  ) {
    return false;
  }

  if (
    message?.id !== archiveMessageId ||
    message?.author?.id !== botId
  ) {
    return false;
  }

  if (typeof message.content !== 'string') {
    return false;
  }

  const lines = message.content
    .split(/\r?\n/)
    .map(line => line.trim());

  if (
    (!lines.includes(MARKER) && !lines.includes(`-# ${MARKER}`)) ||
    !lines.includes(`**ticket:** ${channelId}`)
  ) {
    return false;
  }

  const attachments = message.attachments;

  if (!attachments || typeof attachments.values !== 'function') {
    return false;
  }

  return [...attachments.values()].some(
    attachment =>
      attachment?.name ===
      `cunvrs-redemption-${channelId}.txt`
  );
}
