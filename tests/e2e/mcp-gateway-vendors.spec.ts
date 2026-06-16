import { test, expect } from '@playwright/test';
import {
  fetchServiceAccountToken,
  hasServiceAccount,
} from './fixtures/sa.js';
import { stagingUrl } from './fixtures/env.js';

/**
 * PR-A — gateway-behavior witnesses for vendors *other* than datto-rmm
 * + auvik already wired in #406 / #407. Sibling shape to
 * `mcp-gateway.spec.ts` (PR #406 datto-rmm) and `auvik.spec.ts`
 * (PR #407 auvik); parametric loop instead of one-test-per-vendor
 * because the shape is identical and the per-vendor tool-pick is the
 * only varied axis.
 *
 * Initial scope-target was 7 vendors (rootly / autotask / cipp /
 * liongard / itglue / halopsa / domotz). Pre-coding probe surfaced
 * 3 staging-infra issues (see VENDOR_TOOL_PICKS comment below); the
 * 4 working vendors ship here, the 3 blocked ones each have a
 * follow-up task filed. Anti-stall discipline (boss
 * msg-1781589084752): surfacing the infra issues IS load-bearing
 * harness value, not a scope-loss.
 *
 * ARCHITECTURE-OF-RECORD — tool-pick discipline (sibling-pin to #406):
 *
 * Every chosen tool below satisfies four properties by-construction:
 *
 *   (a) Zero-arg input schema — `inputSchema.required` is empty, so
 *       no test can accidentally supply a customer-affecting filter
 *       (e.g. a ticket-status update flag, a "delete-this-id" param).
 *       The tool's signature itself eliminates the attack surface.
 *   (b) Read-only by semantics — tool name carries `_list_`, `_status`,
 *       or equivalent read-side verb. Mutation-pattern names
 *       (`_create_` / `_update_` / `_delete_` / `_archive_` / `_send_` /
 *       `_post_` / `_cancel_` / `_assign_`) are filter-rejected at
 *       pick-time.
 *   (c) WYRE-owned tenant — the SA-attached staging org connects to
 *       WYRE's own vendor accounts (NOT customer-tenant credentials).
 *       Any READ against these accounts inspects WYRE-managed data
 *       only; zero customer-data exposure surface.
 *   (d) Stable response shape — tests assert structural witnesses
 *       (content[] non-empty + isError != true) rather than pinning
 *       specific IDs or content. Vendor-API churn does NOT flake
 *       the harness.
 *
 * The pick-discipline was tool-list-probe-based (boss-named bottom-up
 * substrate-grounding from msg-1781555258865): we probed staging's
 * actual tools/list output, filtered by the four properties above,
 * and picked the most semantically-status-like result per vendor.
 * No README-only guessing — sibling discipline to ruby's source-
 * citation pattern (PR #405, PR #422).
 */

const VENDOR_TOOL_PICKS: ReadonlyArray<{
  readonly vendor: string;
  readonly tool: string;
  readonly note: string;
}> = [
  // NOTE — 3 vendors INTENTIONALLY EXCLUDED from this batch, each for a
  // distinct staging-infra reason discovered during the pre-coding probe
  // (boss msg-1781589084752 GO on 4-of-7 anti-stall ship):
  //
  //   - rootly: ALL 250 rootly tools return "Internal proxy error" at
  //     conduit /v1/mcp — no JSON-RPC envelope, no upstream details.
  //     Rootly-mcp sidecar is down or misrouted on staging-prod-env.
  //     Tracked: PR-A.7 (forge).
  //   - cipp: ALL CIPP list tools (list_logs / list_tenants / list_users
  //     / list_groups) return HTTP 403 from upstream — the WYRE CIPP
  //     API client lacks read permissions on staging. Tracked: PR-A.6
  //     (forge / cadre-boss).
  //   - liongard: probe-filter found NONE-FOUND on first pass (no _status
  //     + no zero-arg list semantic match); later survey shows multiple
  //     candidates worth a careful read. Tracked: PR-A.5 (dev).
  //
  // When any of these resolve, the fix is one-line: add a tuple to this
  // array. The harness self-extends.
  {
    vendor: 'autotask',
    tool: 'autotask__autotask_list_ticket_statuses',
    note: 'list ticket statuses — zero-arg, read-only catalog tool',
  },
  {
    vendor: 'itglue',
    tool: 'itglue__list_flexible_asset_types',
    note: 'list flexible asset types — zero-arg, read-only schema tool',
  },
  {
    vendor: 'halopsa',
    tool: 'halopsa__halopsa_status',
    note: 'status — zero-arg, connection-check semantics',
  },
  {
    vendor: 'domotz',
    tool: 'domotz__domotz_status',
    note: 'status — zero-arg, connection-check semantics',
  },
];

const MCP_INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'staging-harness-pr-a', version: '1.0.0' },
  },
};

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
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
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`/v1/mcp returned HTTP ${res.status}`);
  }
  return (await res.json()) as JsonRpcResponse<T>;
}

test.describe('FLOW 1 — TENANT — multi-vendor gateway-behavior witnesses', () => {
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

  for (const { vendor, tool, note } of VENDOR_TOOL_PICKS) {
    test(`${vendor}: tools/call ${tool} round-trips successfully (${note})`, async () => {
      const token = await fetchServiceAccountToken();
      await postJsonRpc(mcpUrl, token, MCP_INITIALIZE_BODY);
      const body = await postJsonRpc<CallToolResult>(mcpUrl, token, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: tool, arguments: {} },
      });
      expect(body.error, `${tool} JSON-RPC error: ${JSON.stringify(body.error)}`).toBeUndefined();
      expect(body.result, `${tool} returned no result`).toBeDefined();
      expect(body.result!.isError, `${tool} reported isError=true`).not.toBe(true);
      expect(
        Array.isArray(body.result!.content) && body.result!.content.length > 0,
        `${tool} content[] empty`,
      ).toBe(true);
      // Structural witness — at least one content entry has a text
      // body. Deliberately no payload-shape pinning (vendor APIs
      // change; property (d) preserves the witness across churn).
      const hasText = body.result!.content.some(
        (c) => typeof c.text === 'string' && c.text.length > 0,
      );
      expect(hasText, `${tool} returned no text content`).toBe(true);
    });
  }
});
