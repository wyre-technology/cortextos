/**
 * Discord message normalization.
 *
 * Mirrors the Telegram send normalization (see
 * tests/unit/cli/send-telegram-normalize.test.ts): codex-runtime agents emit
 * shell commands like
 *   bus/send-discord.sh ORCH CHANNELID 'hello\n\nworld'
 * where the `\n` lives inside a single-quoted bash string. Bash does NOT
 * expand escapes inside single quotes, so argv receives the literal 2-char
 * sequence `\n`. Without normalization Discord renders a visible backslash-n
 * instead of a newline.
 *
 * The patch is intentionally narrow — only `\n` and `\t` are converted; other
 * sequences (`\r`, `\xHH`, ...) pass through verbatim so we never surprise a
 * user who legitimately wants a literal backslash in a message. Claude-runtime
 * agents already use real newlines, so this is a no-op for them.
 */
export function normalizeOutboundText(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

/** Discord's hard per-message content limit. */
export const DISCORD_MAX_MESSAGE_CHARS = 2000;

/**
 * Truncate a message to fit Discord's 2000-char limit, appending a marker so
 * the recipient knows content was clipped. Mirrors the Telegram hooks' 3600/
 * 3800-char truncation behavior, adjusted for Discord's smaller ceiling.
 */
export function truncateForDiscord(
  text: string,
  limit: number = DISCORD_MAX_MESSAGE_CHARS,
): string {
  if (text.length <= limit) return text;
  const marker = '...(truncated)';
  return text.slice(0, limit - marker.length) + marker;
}
