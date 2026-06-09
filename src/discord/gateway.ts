/**
 * Discord gateway client (inbound) — the only module that imports discord.js.
 *
 * Mirrors src/telegram/poller.ts: a long-lived connection that RECEIVES
 * messages and hands each one to a registered handler. Where Telegram uses
 * HTTP long-polling (getUpdates), Discord uses a persistent gateway
 * WebSocket, so this is the long-lived WS the daemon must supervise/restart
 * (design spec §12 risk: "introduces a long-lived WS the daemon must
 * supervise/restart").
 *
 * The discord.js Client is created lazily and injected-overridable so the unit
 * + mock tests can drive the adapter with a fake EventEmitter client and never
 * touch a real token or the network (mirrors tests/playwright/
 * mock-telegram-server.ts).
 */

import { loadDiscordConfig, type DiscordConfig } from './config.js';
import { normalizeInbound, type DiscordInboundMessage } from './inbound.js';

/** Handler invoked for every inbound message in the configured channel. */
export type DiscordMessageHandler = (msg: DiscordInboundMessage) => void;

/**
 * The minimal slice of a discord.js Client we depend on. Declaring it locally
 * (rather than importing discord.js types here) keeps gateway.ts testable with
 * a fake client and documents exactly what we use.
 */
export interface GatewayClientLike {
  on(event: 'messageCreate', listener: (message: unknown) => void): unknown;
  on(event: 'ready', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  once(event: 'ready', listener: () => void): unknown;
  login(token: string): Promise<string>;
  destroy(): Promise<void> | void;
}

/** Factory that produces a gateway client from a token's worth of intents. */
export type GatewayClientFactory = () => GatewayClientLike;

/**
 * Map a discord.js Message (or our test fake) onto the narrow
 * DiscordInboundMessage shape inbound.ts consumes. Tolerant of both the real
 * object graph (message.author.bot, message.channelId) and the flat fake used
 * in tests.
 */
export function toInboundMessage(raw: unknown): DiscordInboundMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, any>;
  const author = m.author ?? {};
  const id = String(m.id ?? '');
  const channelId = String(m.channelId ?? m.channel_id ?? '');
  const authorId = String(author.id ?? '');
  const authorName = String(
    author.globalName ?? author.global_name ?? author.username ?? 'Unknown',
  );
  const authorIsBot = Boolean(author.bot);
  const content = String(m.content ?? '');
  if (!id || !channelId) return null;
  return { id, channelId, authorId, authorName, authorIsBot, content };
}

export class DiscordGateway {
  private client: GatewayClientLike | null = null;
  private handlers: DiscordMessageHandler[] = [];
  private readonly config: DiscordConfig;
  private readonly makeClient: GatewayClientFactory;
  private started = false;

  /**
   * @param config       resolved bot token + orchestrator channel id
   * @param clientFactory optional client factory; defaults to a real discord.js
   *                      Client with the Guilds + GuildMessages +
   *                      MessageContent intents. Tests inject a fake.
   */
  constructor(config: DiscordConfig, clientFactory?: GatewayClientFactory) {
    this.config = config;
    this.makeClient = clientFactory ?? createDefaultClientFactory();
  }

  /** Register a handler for inbound messages in the configured channel. */
  onMessage(handler: DiscordMessageHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Wire the client's messageCreate listener and log in. The listener filters
   * to the single configured orchestrator channel — there are no per-agent
   * channels — and forwards everything else nowhere.
   *
   * Returns the connected client so a supervisor can hold the reference.
   */
  async start(): Promise<GatewayClientLike> {
    if (this.started) {
      throw new Error('DiscordGateway already started');
    }
    this.started = true;
    const client = this.makeClient();
    this.client = client;

    client.on('messageCreate', (raw: unknown) => {
      const msg = toInboundMessage(raw);
      if (!msg) return;
      // Orchestrator-only channel filter — drop anything not in the
      // configured #home-orchestrator channel.
      if (msg.channelId !== this.config.orchChannelId) return;
      for (const handler of this.handlers) {
        try {
          handler(msg);
        } catch {
          /* a handler throw must not kill the gateway */
        }
      }
    });

    await client.login(this.config.botToken);
    return client;
  }

  /** Tear down the connection (supervisor restart / agent stop). */
  async stop(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
    this.started = false;
  }
}

/**
 * Build a DiscordGateway from env. Returns null when Discord is not configured
 * (mirrors loadDiscordConfig / loadSlackIdentity null semantics) so the daemon
 * can cheaply ask "is this instance Discord-enabled?".
 */
export function createGatewayFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  clientFactory?: GatewayClientFactory,
): DiscordGateway | null {
  const config = loadDiscordConfig(env);
  if (!config) return null;
  return new DiscordGateway(config, clientFactory);
}

/**
 * Default factory: lazily require discord.js and construct a Client with the
 * intents the orchestrator channel needs. Lazy-required so importing this
 * module (e.g. from inbound unit tests via the barrel) does not force
 * discord.js to load — and so the package builds even where discord.js is an
 * optional/native-free dep.
 *
 * MessageContent is a privileged intent: it must be enabled in the Discord
 * Developer Portal for the bot, or messageCreate payloads arrive with empty
 * content. The setup runbook calls this out.
 */
function createDefaultClientFactory(): GatewayClientFactory {
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client, GatewayIntentBits } = require('discord.js');
    return new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    }) as GatewayClientLike;
  };
}

export { normalizeInbound };
