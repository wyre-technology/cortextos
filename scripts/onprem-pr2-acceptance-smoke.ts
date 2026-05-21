#!/usr/bin/env tsx
/**
 * On-prem stream PR #2 post-deploy acceptance smoke.
 *
 * Boss refinement 3 (2026-05-21): the narrower-T2 in-test choice trades
 * pre-merge harness weight for a small post-deploy verification cost. THIS
 * script is the post-deploy verification — one scripted call against staging
 * that exercises the literal end-to-end path:
 *
 *     /v1/mcp client request
 *           ↓
 *       cloud gateway
 *           ↓  (unified-router on-prem fork)
 *       relay control-plane HTTP
 *           ↓  (HMAC body-binding + relay registry lookup)
 *       relay WSS dispatch
 *           ↓  (tunnel.sendRequest)
 *       on-prem gateway WSS client
 *           ↓
 *       on-prem MCP server (echo)
 *           ↓ ... response threads back ...
 *     /v1/mcp client response
 *
 * The PR's acceptance-checklist names this script as the gated post-deploy
 * step that closes the "narrower-in-test + smoke-post-deploy" coverage
 * split. Run after deploying the PR; assert echo response received.
 *
 * Required env:
 *   - CONDUIT_GATEWAY_URL  e.g. https://staging.conduit.wyre.ai
 *   - CONDUIT_BEARER_TOKEN a valid /v1/mcp bearer for a user whose primary
 *                          org has an on-prem tunnel registered with
 *                          capabilities including 'echo'.
 *
 * Optional:
 *   - SMOKE_TIMEOUT_MS     default 15_000
 *   - SMOKE_MESSAGE        the string to echo (default 'pr2-acceptance-smoke')
 *
 * Exit code 0 on success; non-zero on any failure (network / auth / wrong
 * shape / echo mismatch). CI/runbooks can gate on the exit code.
 */
const GATEWAY_URL = process.env.CONDUIT_GATEWAY_URL;
const BEARER = process.env.CONDUIT_BEARER_TOKEN;
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 15_000);
const MESSAGE = process.env.SMOKE_MESSAGE ?? 'pr2-acceptance-smoke';

if (!GATEWAY_URL || !BEARER) {
  process.stderr.write(
    'FAIL: required env CONDUIT_GATEWAY_URL + CONDUIT_BEARER_TOKEN not set\n',
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const url = `${GATEWAY_URL!.replace(/\/$/, '')}/v1/mcp`;
  const body = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name: 'echo__echo', // {vendor}__{tool} prefix; vendor=echo is the M1 capability
      arguments: { message: MESSAGE },
    },
  };

  process.stdout.write(`POST ${url}\n`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${BEARER}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    process.stderr.write(`FAIL: HTTP ${res.status} ${res.statusText}\n`);
    const text = await res.text().catch(() => '');
    process.stderr.write(`Body: ${text.slice(0, 500)}\n`);
    process.exit(3);
  }

  const parsed = (await res.json()) as {
    jsonrpc?: string;
    id?: unknown;
    result?: { content?: { type: string; text: string }[] };
    error?: { code: number; message: string };
  };

  if (parsed.error) {
    process.stderr.write(
      `FAIL: JSON-RPC error code=${parsed.error.code} message="${parsed.error.message}"\n`,
    );
    process.exit(4);
  }

  const echoText = parsed.result?.content?.[0]?.text;
  if (echoText !== MESSAGE) {
    process.stderr.write(
      `FAIL: echo mismatch — expected "${MESSAGE}", got ${JSON.stringify(echoText)}\n`,
    );
    process.exit(5);
  }

  process.stdout.write(`OK: full T2 path verified end-to-end (echo=${MESSAGE})\n`);
}

main().catch((err) => {
  process.stderr.write(`FAIL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
