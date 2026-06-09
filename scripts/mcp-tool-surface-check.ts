#!/usr/bin/env node
/**
 * MCP tool-surface drift detector.
 *
 * Hits the conduit MCP gateway with a service-client credential, fetches the
 * full `tools/list` JSON-RPC response, and diffs it against a recorded
 * baseline (per-vendor alphabetized tool name list). Exits non-zero if any
 * vendor's tool set has drifted — new tools, removed tools, vendor added or
 * removed, or total-count mismatch.
 *
 * Aaron 2026-06-09 directive: "MCP server tests are automated to the extent
 * that when we make changes, you can still surface tools." This script is the
 * primitive — wired into CI it catches vendor-MCP regressions (e.g. an
 * upstream MCP server crash, a routing-rule drop, a token-scope downgrade)
 * before they reach customers.
 *
 * Env vars:
 *   CONDUIT_GATEWAY_URL    Default https://staging.conduit.wyre.ai. Set to
 *                          https://conduit.wyre.ai once the cutover lands.
 *   CONDUIT_CLIENT_ID      Service-client client_id (required).
 *   CONDUIT_CLIENT_SECRET  Service-client client_secret (required).
 *   BASELINE_PATH          Override path to the baseline JSON. Defaults to
 *                          tests/mcp/baselines/staging-tools.json relative to
 *                          repo root.
 *   ALLOW_NEW_TOOLS        When "1" or "true", new tools added to a vendor
 *                          do NOT fail the check — only removed tools do.
 *                          Useful when a vendor MCP ships a release that
 *                          adds tools intentionally. Removed tools still
 *                          fail (silent regression vector).
 *
 * Exit codes:
 *   0  No drift.
 *   1  Drift detected (vendor added/removed, tool removed, count mismatch,
 *      or new tool when ALLOW_NEW_TOOLS is off).
 *   2  Operational failure (token grant failed, gateway HTTP error,
 *      baseline unreadable, etc.) — distinct from drift so CI can route.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type ToolDescriptor = { name: string; description?: string };
type ToolsListResult = { tools: ToolDescriptor[] };
type Baseline = {
  captured_at: string;
  env: string;
  gateway: string;
  total_tools: number;
  vendors: Array<{ vendor: string; count: number; tools: string[] }>;
};

const GATEWAY = (
  process.env.CONDUIT_GATEWAY_URL ?? "https://staging.conduit.wyre.ai"
).replace(/\/$/, "");
const CLIENT_ID = process.env.CONDUIT_CLIENT_ID;
const CLIENT_SECRET = process.env.CONDUIT_CLIENT_SECRET;
const BASELINE_PATH =
  process.env.BASELINE_PATH ??
  resolve(process.cwd(), "tests/mcp/baselines/staging-tools.json");
const ALLOW_NEW_TOOLS = ["1", "true", "yes"].includes(
  (process.env.ALLOW_NEW_TOOLS ?? "").toLowerCase(),
);

function fail(message: string, code = 2): never {
  console.error(`[mcp-tool-surface-check] ${message}`);
  process.exit(code);
}

if (!CLIENT_ID || !CLIENT_SECRET) {
  fail("CONDUIT_CLIENT_ID and CONDUIT_CLIENT_SECRET env vars are required.");
}

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${GATEWAY}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID!,
      client_secret: CLIENT_SECRET!,
    }),
  });
  if (!res.ok) {
    fail(
      `OAuth token grant failed at ${GATEWAY}/oauth/token: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const payload = (await res.json()) as { access_token?: string };
  if (!payload.access_token) {
    fail("OAuth response did not contain access_token.");
  }
  return payload.access_token!;
}

async function listTools(token: string): Promise<ToolDescriptor[]> {
  const res = await fetch(`${GATEWAY}/v1/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  if (!res.ok) {
    fail(
      `Gateway tools/list failed at ${GATEWAY}/v1/mcp: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const payload = (await res.json()) as {
    result?: ToolsListResult;
    error?: { message: string };
  };
  if (payload.error) {
    fail(`JSON-RPC error from gateway: ${payload.error.message}`);
  }
  if (!payload.result?.tools) {
    fail("JSON-RPC response did not contain result.tools array.");
  }
  return payload.result.tools;
}

function vendorOf(toolName: string): string {
  const idx = toolName.indexOf("__");
  return idx === -1 ? toolName : toolName.slice(0, idx);
}

function tailOf(toolName: string): string {
  const idx = toolName.indexOf("__");
  return idx === -1 ? toolName : toolName.slice(idx + 2);
}

function loadBaseline(): Baseline {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Could not read baseline at ${BASELINE_PATH}: ${msg}`);
  }
}

function summarize(tools: ToolDescriptor[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const t of tools) {
    const vendor = vendorOf(t.name);
    const tail = tailOf(t.name);
    if (!out.has(vendor)) out.set(vendor, new Set());
    out.get(vendor)!.add(tail);
  }
  return out;
}

function main() {
  console.log(`[mcp-tool-surface-check] gateway=${GATEWAY}`);
  console.log(`[mcp-tool-surface-check] baseline=${BASELINE_PATH}`);
  console.log(`[mcp-tool-surface-check] allow_new_tools=${ALLOW_NEW_TOOLS}`);

  const baseline = loadBaseline();
  const expected = new Map(
    baseline.vendors.map((v) => [v.vendor, new Set(v.tools)]),
  );

  return Promise.resolve()
    .then(getAccessToken)
    .then(listTools)
    .then((tools) => {
      const actual = summarize(tools);
      let drift = false;

      const expectedVendors = new Set(expected.keys());
      const actualVendors = new Set(actual.keys());

      for (const vendor of expectedVendors) {
        if (!actualVendors.has(vendor)) {
          console.error(
            `  REMOVED vendor: ${vendor} (had ${expected.get(vendor)!.size} tools)`,
          );
          drift = true;
        }
      }
      for (const vendor of actualVendors) {
        if (!expectedVendors.has(vendor)) {
          console.error(
            `  ADDED vendor: ${vendor} (${actual.get(vendor)!.size} tools)`,
          );
          drift = true;
        }
      }

      for (const vendor of expectedVendors) {
        if (!actualVendors.has(vendor)) continue;
        const expectedTools = expected.get(vendor)!;
        const actualTools = actual.get(vendor)!;
        const removed = [...expectedTools]
          .filter((t) => !actualTools.has(t))
          .sort();
        const added = [...actualTools]
          .filter((t) => !expectedTools.has(t))
          .sort();
        if (removed.length > 0) {
          console.error(`  ${vendor}: REMOVED tools: ${removed.join(", ")}`);
          drift = true;
        }
        if (added.length > 0) {
          const tag = ALLOW_NEW_TOOLS ? "ADDED tools (allowed)" : "ADDED tools";
          console.error(`  ${vendor}: ${tag}: ${added.join(", ")}`);
          if (!ALLOW_NEW_TOOLS) drift = true;
        }
      }

      const totalActual = tools.length;
      if (totalActual !== baseline.total_tools) {
        console.error(
          `  TOTAL_TOOLS drift: baseline=${baseline.total_tools} actual=${totalActual}`,
        );
        drift = true;
      }

      if (drift) {
        console.error("[mcp-tool-surface-check] DRIFT DETECTED.");
        process.exit(1);
      }
      console.log(
        `[mcp-tool-surface-check] OK — ${totalActual} tools across ${actual.size} vendors match baseline.`,
      );
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      fail(`Unexpected failure: ${msg}`);
    });
}

void main();
