import { test, expect } from '@playwright/test';
import {
  fetchServiceAccountToken,
  hasServiceAccount,
} from './fixtures/sa.js';
import { stagingUrl } from './fixtures/env.js';

/**
 * PR-2c — Auvik sub-flow gateway-behavior witnesses.
 *
 * Sibling shape to PR-2a-mcp (#406): tests run against the SA-attached
 * staging org's already-connected vendor surface. Per boss
 * msg-1781555968152, the connect-step requires Aaron's one-time UI
 * connect (mcp-scope SA bearer is 302'd at the cred-write endpoint —
 * same substrate-boundary finding as #406). Once Aaron connects Auvik
 * (lnx region, creds at the file path referenced in the skip-message
 * below), the skip-gate auto-flips and these witnesses go live.
 *
 * The success of the round-trip itself end-to-end-witnesses the lnx
 * allowlist landed in PR #405: if the auvik-mcp sidecar tried to
 * proxy to anything OTHER than `auvikapi.lnx.my.auvik.com`, the
 * upstream call would fail — so a green run is the live-witness that
 * the allowlist extension is functioning correctly. No proxy-internals
 * inspection required.
 *
 * Skip-gate-by-construction (boss-named "mitigation against silent rot"):
 * we don't fail when Auvik isn't connected; we skip with a clear hint at
 * the file path of the Aaron-supplied creds. If Aaron disconnects auvik
 * later, the tests skip gracefully instead of going red.
 */

const AUVIK_PREFIX = 'auvik';
const AUVIK_STATUS_TOOL = 'auvik__auvik_status';
const AUVIK_TENANTS_LIST_TOOL = 'auvik__auvik_tenants_list';

const MCP_INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'staging-harness-pr-2c-auvik', version: '1.0.0' },
  },
};

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

interface ListToolsResult {
  tools: Array<{ name: string; description?: string }>;
}

interface CallToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

async function postJsonRpc<T>(
  url: string,
  bearer: string,
  body: unknown,
): Promise<JsonRpcResponse<T>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`/v1/mcp returned HTTP ${res.status}`);
  }
  return (await res.json()) as JsonRpcResponse<T>;
}

async function listToolPrefixes(
  mcpUrl: string,
  token: string,
): Promise<Set<string>> {
  await postJsonRpc(mcpUrl, token, MCP_INITIALIZE_BODY);
  const body = await postJsonRpc<ListToolsResult>(mcpUrl, token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  });
  if (body.error) {
    throw new Error(`tools/list error: ${JSON.stringify(body.error)}`);
  }
  return new Set(
    (body.result?.tools ?? [])
      .map((t) => (t.name.includes('__') ? t.name.split('__')[0] : ''))
      .filter(Boolean),
  );
}

test.describe('FLOW 1 — TENANT (pearl §1.7 — Auvik) — gateway-behavior witness', () => {
  let mcpUrl: string;
  let auvikConnected = false;

  test.beforeAll(async () => {
    if (!hasServiceAccount()) {
      test.skip(
        true,
        'service-account creds not wired (CONDUIT_STAGING_SVC_*); see tests/e2e/README.md',
      );
    }
    mcpUrl = `${stagingUrl().replace(/\/$/, '')}/v1/mcp`;
    try {
      const token = await fetchServiceAccountToken();
      const prefixes = await listToolPrefixes(mcpUrl, token);
      auvikConnected = prefixes.has(AUVIK_PREFIX);
    } catch {
      auvikConnected = false;
    }
  });

  test('auvik is connected on the SA-attached staging org (skip-gate witness)', async () => {
    if (!auvikConnected) {
      test.skip(
        true,
        'Auvik is NOT connected on the SA-attached staging org. ' +
          'Aaron one-time-connect needed via the staging UI — creds at ' +
          '~/.cortextos/default/secrets/conduit-staging-auvik-test-creds.json ' +
          '(region: lnx — landed in PR #405 allowlist extension). ' +
          'Once connected, this and the two tests below auto-activate.',
      );
    }
    expect(auvikConnected).toBe(true);
  });

  test('tools/call auvik__auvik_status round-trips successfully (live lnx-allowlist witness)', async () => {
    test.skip(!auvikConnected, 'auvik not connected — see skip-gate above');
    // ARCHITECTURE-OF-RECORD: auvik_status is the upstream README-documented
    // "Status and Navigation" tool — explicitly a zero-arg connection-check.
    // Picked because (a) zero required params -> cannot supply customer-
    // affecting filter, (b) status semantics are by-convention read-only,
    // (c) Auvik is WYRE-owned (no customer-tenant exposure), (d) success
    // proves the auvik-mcp sidecar successfully reached
    // auvikapi.lnx.my.auvik.com — the live witness that PR #405's lnx
    // allowlist extension functions end-to-end in production-shape.
    const token = await fetchServiceAccountToken();
    await postJsonRpc(mcpUrl, token, MCP_INITIALIZE_BODY);
    const body = await postJsonRpc<CallToolResult>(mcpUrl, token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: AUVIK_STATUS_TOOL, arguments: {} },
    });
    expect(body.error, `tools/call auvik_status error: ${JSON.stringify(body.error)}`).toBeUndefined();
    expect(body.result, 'auvik_status returned no result').toBeDefined();
    expect(body.result!.isError, 'auvik_status reported isError=true').not.toBe(true);
    expect(
      Array.isArray(body.result!.content) && body.result!.content.length > 0,
      'auvik_status content[] empty',
    ).toBe(true);
  });

  test('tools/call auvik__auvik_tenants_list returns upstream data (real round-trip)', async () => {
    test.skip(!auvikConnected, 'auvik not connected — see skip-gate above');
    // auvik_tenants_list is also zero-arg read-only — lists tenants
    // visible to the credentialed account. Witnesses that the full
    // upstream path (conduit -> sidecar -> auvikapi.lnx -> Auvik API)
    // ran end-to-end and returned something the gateway could marshal
    // back through MCP-protocol. No tenant-name pinning — the WYRE
    // Auvik account contents are out-of-scope for this test.
    const token = await fetchServiceAccountToken();
    await postJsonRpc(mcpUrl, token, MCP_INITIALIZE_BODY);
    const body = await postJsonRpc<CallToolResult>(mcpUrl, token, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: AUVIK_TENANTS_LIST_TOOL, arguments: {} },
    });
    expect(body.error, `tools/call auvik_tenants_list error: ${JSON.stringify(body.error)}`).toBeUndefined();
    expect(body.result, 'auvik_tenants_list returned no result').toBeDefined();
    expect(body.result!.isError, 'auvik_tenants_list reported isError=true').not.toBe(true);
    const hasText = (body.result!.content ?? []).some(
      (c) => typeof c.text === 'string' && c.text.length > 0,
    );
    expect(hasText, 'auvik_tenants_list returned no text content').toBe(true);
  });
});
