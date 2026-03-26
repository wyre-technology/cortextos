/**
 * HTTP client for the MCP Gateway CLI endpoints.
 */

import { loadToken } from './config.js';
import type { TokenData } from './config.js';

export interface CliFlag {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface CliCommand {
  command: string;
  description: string;
  flags: CliFlag[];
}

export interface SchemaResponse {
  vendor: string;
  vendorName: string;
  commands: CliCommand[];
}

function requireToken(): TokenData {
  const token = loadToken();
  if (!token) {
    console.error('Not authenticated. Run: mcpgw auth login');
    process.exit(1);
  }
  return token;
}

/**
 * Fetch CLI schema for a vendor (available commands + flags).
 */
export async function fetchSchema(vendor: string): Promise<SchemaResponse> {
  const token = requireToken();

  const res = await fetch(`${token.gatewayUrl}/v1/${vendor}/cli/schema`, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }

  return (await res.json()) as SchemaResponse;
}

export interface ToolCallResult {
  result: unknown;
  timing?: {
    authMs: number;
    sessionMs: number;
    vendorMs: number;
    totalMs: number;
  };
}

/**
 * Execute a tool call via the CLI endpoint.
 * Returns the result and optional gateway timing breakdown.
 */
export async function callTool(
  vendor: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const token = requireToken();

  const res = await fetch(`${token.gatewayUrl}/v1/${vendor}/cli`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tool, args }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }

  const data = (await res.json()) as { result: unknown };

  // Parse gateway timing headers
  const totalMs = res.headers.get('x-total-ms');
  const timing = totalMs ? {
    authMs: Number(res.headers.get('x-auth-ms') ?? 0),
    sessionMs: Number(res.headers.get('x-session-ms') ?? 0),
    vendorMs: Number(res.headers.get('x-vendor-ms') ?? 0),
    totalMs: Number(totalMs),
  } : undefined;

  return { result: data.result, timing };
}
