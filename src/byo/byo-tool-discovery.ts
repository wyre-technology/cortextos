/**
 * BYOMCP tool discovery (WYREAI-189).
 *
 * Enumerates the tools a user's own (non-catalog) MCP server exposes, REUSING
 * the existing `ToolCache` machinery (MCP Streamable HTTP handshake + 5-minute
 * TTL + concurrent-fetch dedup) rather than forking a parallel discovery path.
 * The only BYO-specific glue:
 *
 *   1. SSRF — the BYO endpoint is user-supplied and `ToolCache` does NOT
 *      validate (its catalog callers pass trusted infra URLs). So we
 *      `validateVendorBaseUrl` the endpoint BEFORE handing it to the cache.
 *      This is the same hard invariant the transport (#460) and storage (#461)
 *      enforce on every BYO fetch.
 *
 *   2. Owner-scoped cache key — `ToolCache` is an in-memory Map keyed by a
 *      string, NOT an RLS-backed store. Catalog discovery keys by vendor slug
 *      (global, same tools for everyone). A BYO server is per-user, so its key
 *      is namespaced `byo:<userId>:<serverId>` — one user's discovered tools
 *      can never be served from another user's cache entry. The owner-only
 *      source read (service.get under the request-path RLS context) is the
 *      authoritative scope; the namespaced key keeps the cache consistent with
 *      it.
 *
 * The auth headers fed to the cache come from the #461 store (service.get
 * decrypts them) — static headers, or the `Authorization: Bearer …` derived
 * from the OAuth tokens the #187 callback persisted. No fork, no second
 * credential path.
 */
import type { ByoMcpServerService } from './byo-mcp-service.js';
import type { ToolCache, McpTool } from '../proxy/tool-cache.js';
import { validateVendorBaseUrl } from '../credentials/safe-fetch.js';
import { classifyByoTools, type ClassifiedByoTool } from './byo-tool-classifier.js';
import type { PermissionTier } from '../auth/tier-check.js';

export class ByoToolDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ByoToolDiscoveryError';
  }
}

/** The owner-scoped in-memory cache key for a BYO server's discovered tools. */
export function byoCacheKey(userId: string, byoServerId: string): string {
  return `byo:${userId}:${byoServerId}`;
}

export class ByoToolDiscoveryService {
  constructor(
    private readonly service: Pick<ByoMcpServerService, 'get'>,
    private readonly toolCache: Pick<ToolCache, 'getTools' | 'invalidate'>,
  ) {}

  /**
   * Discover the tools exposed by the caller's BYO server. Owner-scoped: loads
   * the server under the request-path RLS context (returns null → not the
   * owner / not found), SSRF-validates the endpoint, then reuses ToolCache.
   */
  async discover(userId: string, byoServerId: string): Promise<McpTool[]> {
    const server = await this.service.get(userId, byoServerId);
    if (!server) {
      throw new ByoToolDiscoveryError('BYO MCP server not found');
    }

    // SSRF gate BEFORE the cache touches the network. Non-negotiable — the
    // endpoint is user-controlled and ToolCache fetches it verbatim.
    await validateVendorBaseUrl(server.endpointUrl);

    // endpoint_url is the full MCP URL, so mcpPath='' — ToolCache must not
    // append '/mcp' to it (it builds `${url}${mcpPath}`).
    return this.toolCache.getTools(
      byoCacheKey(userId, byoServerId),
      server.endpointUrl,
      server.headers,
      '',
    );
  }

  /**
   * Discover the caller's BYO tools AND classify each into its required
   * permission tier (WYREAI-190). Same owner-scoping + SSRF guarantees as
   * discover() — classification is a pure post-step on the discovered metadata,
   * reusing the catalog tier resolver (see byo-tool-classifier.ts).
   */
  async discoverClassified(
    userId: string,
    byoServerId: string,
    overrides?: ReadonlyMap<string, PermissionTier>,
  ): Promise<ClassifiedByoTool[]> {
    const tools = await this.discover(userId, byoServerId);
    return classifyByoTools(tools, overrides);
  }

  /** Drop the cached tool list for one BYO server (e.g. after a re-connect). */
  invalidate(userId: string, byoServerId: string): void {
    this.toolCache.invalidate(byoCacheKey(userId, byoServerId));
  }
}
