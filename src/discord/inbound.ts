/**
 * Discord inbound routing.
 *
 * Mirrors the Telegram inbound path (src/telegram/logging.ts
 * `recordInboundTelegram` + the agent-manager `onMessage` handler that
 * delivers to the agent): a message posted in the configured orchestrator
 * channel is normalized, archived to the agent's JSONL inbound log, a
 * `message/discord_received` bus event is emitted (symmetric with the
 * `discord_sent` event from the outbound CLI path), and the text is delivered
 * to the orchestrator's bus inbox via the shared `sendMessage` primitive — the
 * exact same inbox write Telegram/cron/agent-to-agent traffic uses
 * (src/bus/message.ts writes inbox/{to}/*.json).
 *
 * Scope: orchestrator only. There are no per-agent Discord channels; every
 * inbound message is routed to a single configured agent (the orchestrator).
 */

import type { BusPaths } from '../types/index.js';
import { logEvent } from '../bus/event.js';
import { logInboundMessage } from '../telegram/logging.js';
import { sendMessage } from '../bus/message.js';
import { stripControlChars } from '../utils/validate.js';

/**
 * The minimal shape of a Discord gateway message we consume. discord.js
 * Message objects are far richer, but keeping our own narrow interface means
 * inbound.ts (and its tests) never import discord.js — the gateway adapter in
 * gateway.ts maps the real Message onto this before calling in.
 */
export interface DiscordInboundMessage {
  /** Message snowflake id. */
  id: string;
  /** Channel snowflake the message was posted in. */
  channelId: string;
  /** Author snowflake id. */
  authorId: string;
  /** Author display name (username / global name). */
  authorName: string;
  /** Whether the author is a bot — used to ignore our own + other bots' posts. */
  authorIsBot: boolean;
  /** Raw message content. */
  content: string;
}

/** Normalized inbound message ready for archiving + delivery. */
export interface NormalizedDiscordMessage {
  messageId: string;
  channelId: string;
  fromId: string;
  fromName: string;
  text: string;
}

/**
 * Normalize a raw gateway message: strip control characters from author name
 * and content (matching the Telegram handler's `stripControlChars`), so the
 * downstream injection text is clean.
 */
export function normalizeInbound(
  msg: DiscordInboundMessage,
): NormalizedDiscordMessage {
  return {
    messageId: msg.id,
    channelId: msg.channelId,
    fromId: msg.authorId,
    fromName: stripControlChars(msg.authorName || 'Unknown'),
    text: stripControlChars(msg.content || ''),
  };
}

export interface DeliverInboundOptions {
  paths: BusPaths;
  ctxRoot: string;
  /** Orchestrator agent name — the sole inbound target. */
  orchestrator: string;
  org: string;
  message: DiscordInboundMessage;
  /** Optional logger (daemon supplies one; tests omit it). */
  log?: (m: string) => void;
}

/**
 * Result of a delivery attempt. `delivered:false` with a `reason` is a normal
 * outcome (bot author, wrong channel, empty content) — the gateway adapter
 * uses it to decide whether to skip without treating it as an error.
 */
export type DeliverResult =
  | { delivered: true; busMessageId: string }
  | { delivered: false; reason: 'bot_author' | 'empty' };

/**
 * Archive + deliver a normalized inbound Discord message to the orchestrator's
 * bus inbox. Channel filtering is the caller's responsibility (the gateway
 * only wires the configured DISCORD_ORCH_CHANNEL_ID), so this function trusts
 * that any message it receives belongs to the orchestrator channel.
 */
export function deliverInbound(opts: DeliverInboundOptions): DeliverResult {
  const { paths, ctxRoot, orchestrator, org, message, log } = opts;

  // Never echo our own bot's posts (or any bot's) back into the inbox — that
  // is the Discord equivalent of the Telegram self-loop guard.
  if (message.authorIsBot) {
    return { delivered: false, reason: 'bot_author' };
  }

  const norm = normalizeInbound(message);
  if (!norm.text.trim()) {
    return { delivered: false, reason: 'empty' };
  }

  // Archive to the orchestrator's JSONL inbound log (reuses the Telegram
  // logger — the schema is adapter-agnostic).
  logInboundMessage(ctxRoot, orchestrator, {
    message_id: norm.messageId,
    from: norm.fromId,
    from_name: norm.fromName,
    channel_id: norm.channelId,
    text: norm.text,
    source: 'discord',
    timestamp: new Date().toISOString(),
  });

  // Emit a bus event so dashboards / experiment cycles can count inbound
  // Discord traffic — symmetric with the outbound `discord_sent` event. A
  // logEvent failure must not break delivery.
  try {
    logEvent(paths, orchestrator, org, 'message', 'discord_received', 'info', {
      channel_id: norm.channelId,
      message_id: norm.messageId,
      from_id: norm.fromId,
      from_name: norm.fromName,
      text_chars: norm.text.length,
    });
  } catch (err) {
    log?.(`logEvent(discord_received) failed: ${err}`);
  }

  // Deliver to the orchestrator's bus inbox via the shared primitive — the
  // same inbox/{to}/*.json write the rest of the bus uses. We attribute the
  // message to a synthetic `discord` sender so the orchestrator can tell it
  // came from the human control plane, mirroring how Telegram messages are
  // tagged in the injection text.
  const text = `[discord from ${norm.fromName}] ${norm.text}`;
  const busMessageId = sendMessage(paths, 'discord', orchestrator, 'normal', text);
  return { delivered: true, busMessageId };
}
