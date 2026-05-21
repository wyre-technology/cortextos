/**
 * Echo MCP server — the trivial M1 payload.
 *
 * M1 scope doc: the tunnel is the load-bearing architectural risk; M1 proves
 * it end-to-end against the CHEAPEST possible payload before any real MCP
 * server (M2). This echo server IS that payload — it lets reduced-T2
 * (request flows gateway→relay→WSS→server→back) be proven without standing
 * up a real LDAP/SQL MCP server, real credentials, or the docker bundle.
 *
 * It speaks just enough of MCP's JSON-RPC shape to be a credible payload:
 * `initialize`, `tools/list` (one tool: `echo`), and `tools/call` for `echo`.
 * Nothing here touches a credential or an on-prem resource — by construction,
 * M1 carries no secret over the tunnel.
 */

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

const ECHO_TOOL = {
  name: 'echo',
  description: 'Returns its input unchanged. The M1 tunnel-proof payload.',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string', description: 'Text to echo back' } },
    required: ['message'],
  },
};

/**
 * Handle one MCP JSON-RPC request against the echo server. This is the
 * function the on-prem gateway's TunnelClient `onRequest` handler calls for
 * `target === 'echo'`.
 */
export function handleEchoMcp(body: unknown): unknown {
  const req = (typeof body === 'object' && body !== null ? body : {}) as JsonRpcRequest;
  const id = req.id ?? null;

  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'onprem-echo', version: '1.0.0' },
        },
      };

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: [ECHO_TOOL] } };

    case 'tools/call': {
      const params = (req.params ?? {}) as { name?: string; arguments?: { message?: unknown } };
      if (params.name !== 'echo') {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${String(params.name)}` },
        };
      }
      const message = params.arguments?.message;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: typeof message === 'string' ? message : JSON.stringify(message) }],
        },
      };
    }

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${String(req.method)}` },
      };
  }
}
