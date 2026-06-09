/**
 * Discord adapter configuration.
 *
 * Mirrors how the Slack adapter reads SLACK_BOT_TOKEN and the Telegram adapter
 * reads BOT_TOKEN / CHAT_ID: the secret + channel live in the instance env
 * (e.g. ~/.cortextos/home/.env, never committed). The adapter is
 * orchestrator-scoped, so there is exactly one channel id.
 *
 *   DISCORD_BOT_TOKEN        — the gateway/REST bot token
 *   DISCORD_ORCH_CHANNEL_ID  — the single #home-orchestrator channel snowflake
 */

export interface DiscordConfig {
  botToken: string;
  orchChannelId: string;
}

/**
 * Resolve Discord config from a provided env map (defaults to process.env so
 * tests can inject a fixture). Returns null when either value is missing —
 * the "Discord-disabled" signal, a normal state for instances that don't use
 * the Discord control plane (symmetric with loadSlackIdentity returning null).
 */
export function loadDiscordConfig(
  env: NodeJS.ProcessEnv = process.env,
): DiscordConfig | null {
  const botToken = (env.DISCORD_BOT_TOKEN || '').trim();
  const orchChannelId = (env.DISCORD_ORCH_CHANNEL_ID || '').trim();
  if (!botToken || !orchChannelId) return null;
  return { botToken, orchChannelId };
}
