import { Command } from 'commander';
import {
  DiscordRestAPI,
  loadDiscordConfig,
  normalizeOutboundText,
  type CreateMessageRequest,
} from '../discord/index.js';

export interface TestSendOptions {
  /** Channel id; falls back to DISCORD_ORCH_CHANNEL_ID when omitted. */
  channel?: string;
  text: string;
  /** Optional message id to reply to (threads the post under it). */
  replyTo?: string;
  /** Resolved env (defaults to process.env; injectable for tests). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Pure function — testable without process exit. Builds the createMessage
 * payload (normalizing codex-style literal \n / \t the same way send-telegram
 * does) and posts it via the injected REST client.
 *
 * Channel resolution mirrors the orchestrator-only scope: if no explicit
 * channel is given, the configured DISCORD_ORCH_CHANNEL_ID is used.
 */
export async function runTestSend(
  opts: TestSendOptions,
  api: DiscordRestAPI,
): Promise<CreateMessageResponseLike> {
  const env = opts.env ?? process.env;
  const channel = opts.channel || (env.DISCORD_ORCH_CHANNEL_ID || '').trim();
  if (!channel) {
    throw new Error(
      'no channel: pass a channel id or set DISCORD_ORCH_CHANNEL_ID',
    );
  }
  const req: CreateMessageRequest = {
    channel,
    content: normalizeOutboundText(opts.text),
  };
  if (opts.replyTo) req.replyToMessageId = opts.replyTo;
  return api.createMessage(req);
}

// Minimal structural return type so the pure function does not couple the CLI
// to the concrete response interface (and tests can assert on it).
interface CreateMessageResponseLike {
  id: string;
  channel_id: string;
}

function requireToken(env: NodeJS.ProcessEnv = process.env): string {
  const cfgToken = (env.DISCORD_BOT_TOKEN || '').trim();
  if (!cfgToken) {
    console.error(
      'DISCORD_BOT_TOKEN not set. See docs/runbook/discord-app-setup for setup.',
    );
    process.exit(1);
  }
  return cfgToken;
}

const testSendCommand = new Command('test-send')
  .argument('[channel]', 'Discord channel id (snowflake); defaults to DISCORD_ORCH_CHANNEL_ID')
  .argument('<text>', 'Message text')
  .option('--reply-to <messageId>', 'Reply to (thread under) this message id')
  .description('Post a test message to the Discord orchestrator channel')
  .action(async (channel: string | undefined, text: string, options: { replyTo?: string }) => {
    const api = new DiscordRestAPI(requireToken());
    try {
      await runTestSend({ channel, text, replyTo: options.replyTo }, api);
      console.log('sent');
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

const whoamiCommand = new Command('whoami')
  .description('Print the bot user the DISCORD_BOT_TOKEN authenticates as')
  .action(async () => {
    const api = new DiscordRestAPI(requireToken());
    try {
      const me = await api.getCurrentUser();
      console.log(`${me.id}\t${me.username}${me.bot ? ' (bot)' : ''}`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

const statusCommand = new Command('status')
  .description('Report whether this instance is Discord-enabled (token + channel set)')
  .action(() => {
    const config = loadDiscordConfig();
    if (!config) {
      console.log(
        'Discord: not configured (set DISCORD_BOT_TOKEN and DISCORD_ORCH_CHANNEL_ID)',
      );
      return;
    }
    console.log(`Discord: configured (orchestrator channel ${config.orchChannelId})`);
  });

export const discordCommand = new Command('discord')
  .description('Discord adapter ops')
  .addCommand(testSendCommand)
  .addCommand(whoamiCommand)
  .addCommand(statusCommand);
