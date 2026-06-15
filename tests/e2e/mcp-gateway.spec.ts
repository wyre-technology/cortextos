import { test, expect } from '@playwright/test';
import {
  fetchServiceAccountToken,
  hasServiceAccount,
} from './fixtures/sa.js';
import { stagingUrl } from './fixtures/env.js';

/**
 * PR-2a-mcp — MCP gateway behavior witness against staging.
 *
 * Substrate boundary (boss msg-1781555620246): on staging, the
 * `/api/orgs/:orgId/credentials/:vendorSlug` cred-write surface is
 * user-session-gated (302 → /auth/login when the mcp-scope SA bearer
 * is presented), but the `/v1/mcp` MCP-protocol surface ACCEPTS the
 * SA bearer. This file tests the second axis — gateway-end-to-end
 * behavior on an org with vendors already connected. The connect-flow
 * tests (BYOC path a — Aaron-pending test-account) ship in
 * PR-2a-connect once the test-account substrate lands.
 *
 * The SA-attached staging org is a real production-like fixture with
 * ~459 tools across multiple connected vendors (itglue, datto-rmm,
 * domotz, autotask, halopsa, ...). The tool-call witness below hits
 * a Datto RMM read-only endpoint against the WYRE-owned Datto account
 * — no customer-data side-effects by-construction.
 */

const DATTO_LIST_SITES_TOOL = 'datto-rmm__datto_list_sites';

const MCP_INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'staging-harness-pr-2a-mcp', version: '1.0.0' },
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

test.describe('FLOW 1 — TENANT (pearl §1.8/1.9/1.10) — MCP gateway behavior witness', () => {
  let mcpUrl: string;

  test.beforeAll(() => {
    if (!hasServiceAccount()) {
      test.skip(
        true,
        'service-account creds not wired (CONDUIT_STAGING_SVC_*); see tests/e2e/README.md',
      );
    }
    mcpUrl = `${stagingUrl().replace(/\/$/, '')}/v1/mcp`;
  });

  test('1.8 /v1/mcp initialize returns a valid MCP-protocol handshake', async () => {
    const token = await fetchServiceAccountToken();
    const body = await postJsonRpc<{ protocolVersion: string; serverInfo: { name: string } }>(
      mcpUrl,
      token,
      MCP_INITIALIZE_BODY,
    );
    expect(body.error, `unexpected JSON-RPC error: ${JSON.stringify(body.error)}`).toBeUndefined();
    expect(body.result).toBeDefined();
    expect(body.result!.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.result!.serverInfo.name, 'serverInfo.name should be conduit-shaped').toBeTruthy();
  });

  test('1.9 /v1/mcp tools/list surfaces the SA-attached orgs connected vendors', async () => {
    const token = await fetchServiceAccountToken();
    await postJsonRpc(mcpUrl, token, MCP_INITIALIZE_BODY);
    const body = await postJsonRpc<ListToolsResult>(mcpUrl, token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    expect(body.error, `tools/list error: ${JSON.stringify(body.error)}`).toBeUndefined();
    expect(body.result?.tools, 'tools[] missing').toBeDefined();
    const tools = body.result!.tools;
    expect(tools.length, 'expected a non-empty tools list — SA-org has zero connections').toBeGreaterThan(0);

    // Witness: the SA-attached org has datto-rmm + itglue connected. If
    // either of these disappears, something connection-side changed on
    // staging and this test is the early-warning signal. Pinning by
    // VENDOR PREFIX (not exact tool count) so adding tools to a vendor
    // without removing the vendor doesnt flake the test.
    const prefixes = new Set(
      tools.map((t) => (t.name.includes('__') ? t.name.split('__')[0] : '')).filter(Boolean),
    );
    expect(prefixes, 'datto-rmm prefix not surfaced').toContain('datto-rmm');
    expect(prefixes, 'itglue prefix not surfaced').toContain('itglue');
  });

  test('1.10 /v1/mcp tools/call round-trips a READ-ONLY Datto RMM list-sites tool', async () => {
    // ARCHITECTURE-OF-RECORD: this test hits the WYRE-owned Datto RMM
    // account (the same account conduit-prod proxies for real customer
    // operations). The chosen tool — `datto-rmm__datto_list_sites` —
    // is strictly read-only: it issues a GET to Dattos public-API
    // /sites endpoint with no side-effects in either Datto or conduit.
    // Picked because (a) `*_list_*` semantics are read-only by
    // convention, (b) the tool requires NO input parameters so the
    // test cant accidentally supply a customer-affecting filter, (c)
    // Datto RMM is WYRE-owned (NOT a customer-owned tenant the harness
    // could pollute), and (d) the response shape is stable JSON the
    // assertions below can witness without pinning specific site IDs.
    const token = await fetchServiceAccountToken();
    await postJsonRpc(mcpUrl, token, MCP_INITIALIZE_BODY);
    const body = await postJsonRpc<CallToolResult>(mcpUrl, token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: DATTO_LIST_SITES_TOOL, arguments: {} },
    });
    expect(body.error, `tools/call error: ${JSON.stringify(body.error)}`).toBeUndefined();
    expect(body.result, 'tools/call returned no result').toBeDefined();
    expect(body.result!.isError, 'tools/call reported isError=true').not.toBe(true);
    expect(
      Array.isArray(body.result!.content) && body.result!.content.length > 0,
      'tools/call content[] empty',
    ).toBe(true);
    // Shape witness: at least one content entry has text-like body. We
    // dont pin Datto-specific payload keys (the upstream JSON shape is
    // not in our control); just witness that the round-trip succeeded
    // and SOMETHING came back.
    const hasText = body.result!.content.some(
      (c) => typeof c.text === 'string' && c.text.length > 0,
    );
    expect(hasText, 'no text content in tools/call response').toBe(true);
  });
});
