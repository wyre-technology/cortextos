/**
 * In-memory cache for vendor tool discovery via MCP tools/list.
 *
 * Semantics:
 *   - 5-minute TTL per vendor slug
 *   - Deduplicates concurrent fetches for the same vendor
 *   - Throws on error so the discover endpoint can surface the actual cause
 *
 * Uses the MCP Streamable HTTP handshake:
 *   1. POST initialize  → capture Mcp-Session-Id if returned
 *   2. POST notifications/initialized (with session ID if present)
 *   3. POST tools/list  (with session ID if present)
 *
 * Sending all three as a JSON-RPC batch breaks servers that don't support
 * batch requests (they return HTTP 400). Sequential requests work for both
 * stateless servers (no session ID returned) and stateful ones.
 */

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface CacheEntry {
  tools: McpTool[];
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes

type JsonRpcResult = { id?: number; result?: { tools?: McpTool[] } };

export class ToolCache {
  private cache = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<McpTool[]>>();

  async getTools(
    vendorSlug: string,
    containerUrl: string,
    headers: Record<string, string>,
  ): Promise<McpTool[]> {
    // Check cache first
    const cached = this.cache.get(vendorSlug);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.tools;
    }

    // Deduplicate concurrent fetches
    const existing = this.inflight.get(vendorSlug);
    if (existing) return existing;

    const promise = this.fetchTools(vendorSlug, containerUrl, headers);
    this.inflight.set(vendorSlug, promise);

    try {
      return await promise;
    } finally {
      this.inflight.delete(vendorSlug);
    }
  }

  invalidate(vendorSlug?: string): void {
    if (vendorSlug) {
      this.cache.delete(vendorSlug);
    } else {
      this.cache.clear();
    }
  }

  private async fetchTools(
    vendorSlug: string,
    containerUrl: string,
    headers: Record<string, string>,
  ): Promise<McpTool[]> {
    const url = `${containerUrl}/mcp`;
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    };

    // Step 1: initialize — capture session ID if server is stateful
    const initRes = await fetch(url, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'mcp-gateway-tool-cache', version: '1.0.0' },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!initRes.ok) {
      throw new Error(`MCP server returned HTTP ${initRes.status} for ${vendorSlug}`);
    }

    const sessionId = initRes.headers.get('mcp-session-id');
    const sessionHeaders: Record<string, string> = sessionId
      ? { ...baseHeaders, 'Mcp-Session-Id': sessionId }
      : baseHeaders;

    // Step 2: notifications/initialized — fire-and-forget; errors are non-fatal
    await fetch(url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});

    // Step 3: tools/list
    const toolsRes = await fetch(url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!toolsRes.ok) {
      throw new Error(`MCP server returned HTTP ${toolsRes.status} for ${vendorSlug}`);
    }

    let tools: McpTool[] = [];
    const contentType = toolsRes.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream')) {
      // SSE response — each result is a separate data: event; find tools/list (id: 2)
      const sseText = await toolsRes.text();
      for (const line of sseText.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.slice(6)) as JsonRpcResult | JsonRpcResult[];
            const items = Array.isArray(event) ? event : [event];
            for (const item of items) {
              if (item.result?.tools) {
                tools = item.result.tools;
                break;
              }
            }
            if (tools.length > 0) break;
          } catch {
            // skip non-JSON data lines
          }
        }
      }
    } else {
      // JSON response
      const rawText = await toolsRes.text();
      let data: JsonRpcResult;
      try {
        data = JSON.parse(rawText) as JsonRpcResult;
      } catch {
        throw new Error(`MCP server returned non-JSON response for ${vendorSlug}`);
      }
      tools = data?.result?.tools ?? [];
    }

    this.cache.set(vendorSlug, { tools, expiresAt: Date.now() + TTL_MS });
    return tools;
  }
}
