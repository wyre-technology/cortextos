/**
 * Discord REST API client using built-in fetch (Node.js 18+).
 * No external dependencies — mirrors src/slack/api.ts.
 *
 * Used for OUTBOUND sends (orchestrator -> channel) and hook round-trip
 * posts. The persistent gateway WebSocket (inbound) lives in gateway.ts and
 * is the only place discord.js is imported, keeping this module — and its
 * unit tests — token/network-free and dependency-light.
 *
 * Scope: only the subset the orchestrator-scoped adapter needs —
 * createMessage (with optional reply reference) and getCurrentUser (used by
 * the CLI to confirm the bot token before going live, analogous to Slack
 * auth.test / Telegram getMe).
 */

const DEFAULT_API_BASE = 'https://discord.com/api/v10';

export interface CreateMessageRequest {
  /** Discord channel id (snowflake). */
  channel: string;
  /** Message content (<= 2000 chars; caller is responsible for chunking). */
  content: string;
  /**
   * Optional message id to reply to. Mirrors Telegram reply_to_message_id and
   * is used by the hook round-trips so an ask/permission reply threads under
   * the prompt it answers.
   */
  replyToMessageId?: string;
}

export interface CreateMessageResponse {
  /** Snowflake id of the created message. */
  id: string;
  channel_id: string;
}

export interface CurrentUser {
  id: string;
  username: string;
  bot?: boolean;
}

export class DiscordRestAPI {
  private readonly apiBase: string;

  constructor(
    private readonly token: string,
    apiBase: string = DEFAULT_API_BASE,
  ) {
    if (!token) throw new Error('DiscordRestAPI: token is required');
    // Normalize trailing slash so callers can pass either form (the mock
    // server in tests hands us a bare http://localhost:PORT base).
    this.apiBase = apiBase.replace(/\/$/, '');
  }

  /**
   * Generic Discord REST call — handles bot auth, JSON, and non-2xx errors.
   * Discord uses the `Bot <token>` authorization scheme (not Bearer).
   */
  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON error body — surfaced via status below */
      }
    }
    if (!res.ok) {
      const message =
        (json as { message?: string }).message ?? `HTTP ${res.status}`;
      throw new Error(`discord ${method} ${path}: ${message}`);
    }
    return json as T;
  }

  /** POST /channels/{id}/messages — the outbound send primitive. */
  async createMessage(req: CreateMessageRequest): Promise<CreateMessageResponse> {
    const body: Record<string, unknown> = { content: req.content };
    if (req.replyToMessageId) {
      // fail_if_not_exists:false so a deleted parent degrades to a normal
      // post instead of erroring the whole send.
      body.message_reference = {
        message_id: req.replyToMessageId,
        fail_if_not_exists: false,
      };
    }
    return this.call<CreateMessageResponse>(
      'POST',
      `/channels/${req.channel}/messages`,
      body,
    );
  }

  /** GET /users/@me — confirm the bot token (CLI test-send / status). */
  async getCurrentUser(): Promise<CurrentUser> {
    return this.call<CurrentUser>('GET', '/users/@me');
  }
}
