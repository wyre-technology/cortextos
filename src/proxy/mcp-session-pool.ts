/**
 * Pool of initialized MCP sessions for vendor containers.
 *
 * Avoids the 3-request handshake (initialize → notify → tools/call)
 * on every CLI request by caching session IDs per vendor+credential combo.
 *
 * Sessions are evicted after a TTL or on error (stale session).
 */

import { createHash } from 'node:crypto';

interface PooledSession {
  sessionId: string | null; // null for stateless servers
  containerUrl: string;
  baseHeaders: Record<string, string>;
  createdAt: number;
}

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class McpSessionPool {
  private pool = new Map<string, PooledSession>();
  private inflight = new Map<string, Promise<PooledSession>>();

  /**
   * Build a cache key from vendor slug + credential headers.
   * Uses a SHA-256 hash of sorted header values so we don't store raw creds.
   */
  private buildKey(vendorSlug: string, credHeaders: Record<string, string>): string {
    const sorted = Object.entries(credHeaders).sort(([a], [b]) => a.localeCompare(b));
    const hash = createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
    return `${vendorSlug}:${hash}`;
  }

  /**
   * Get or create an initialized MCP session.
   */
  async getSession(
    vendorSlug: string,
    containerUrl: string,
    credHeaders: Record<string, string>,
  ): Promise<PooledSession> {
    const key = this.buildKey(vendorSlug, credHeaders);

    // Check cache
    const cached = this.pool.get(key);
    if (cached && (Date.now() - cached.createdAt) < SESSION_TTL_MS) {
      return cached;
    }

    // Deduplicate concurrent handshakes for the same key
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = this.initSession(key, containerUrl, credHeaders);
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * Evict a session (e.g. after a request fails with a session error).
   */
  evict(vendorSlug: string, credHeaders: Record<string, string>): void {
    const key = this.buildKey(vendorSlug, credHeaders);
    this.pool.delete(key);
  }

  /**
   * Perform the MCP initialize + notify handshake.
   */
  private async initSession(
    key: string,
    containerUrl: string,
    credHeaders: Record<string, string>,
  ): Promise<PooledSession> {
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...credHeaders,
    };

    // Step 1: initialize
    const initRes = await fetch(containerUrl, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'mcp-gateway-cli', version: '1.0.0' },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!initRes.ok) {
      throw new Error(`MCP server returned ${initRes.status} during initialization`);
    }

    const sessionId = initRes.headers.get('mcp-session-id');
    const sessionHeaders: Record<string, string> = sessionId
      ? { ...baseHeaders, 'Mcp-Session-Id': sessionId }
      : baseHeaders;

    // Step 2: notifications/initialized (fire-and-forget)
    fetch(containerUrl, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});

    const session: PooledSession = {
      sessionId,
      containerUrl,
      baseHeaders: sessionHeaders,
      createdAt: Date.now(),
    };

    this.pool.set(key, session);
    return session;
  }
}
