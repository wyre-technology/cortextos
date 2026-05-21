/**
 * Per-request memoized lookup: does this org have a live on-prem tunnel, and
 * what capabilities does it carry?
 *
 * PR #2 §4 step 5 — boss pin 2: cache at request scope, not query-per-call.
 * If a single `/v1/mcp` request triggers multiple `tools/call` dispatches
 * (some MCP clients batch), the on-prem caps read MUST happen once per
 * request, not once per call.
 *
 * Reads `onprem_tunnels` request-path (via `getSql()`, NOBYPASSRLS as
 * `conduit_request`) — gated by the SELECT policy migration 033 adds:
 *   conduit_is_member_of_org(user, subtenant_id)
 *     OR conduit_is_reseller_member_of_parent(user, subtenant_id)
 * If the user has no membership-or-reseller path to the org, RLS returns
 * zero rows and the helper returns null — the on-prem fork falls through.
 *
 * Boss pin 3 (canonical slug match): this helper returns the EXACT
 * capability strings the tunnel registered with — no normalization,
 * lowercasing, or fuzzy-matching. The dispatch site compares the requested
 * tool's vendor slug to `caps.includes(slug)` byte-for-byte.
 */
import type { FastifyRequest } from 'fastify';
import { getSql } from '../db/context.js';

const CACHE_KEY = Symbol.for('conduit.request.onpremCaps');

interface CacheEntry {
  orgId: string;
  /** null = no live tunnel found for this org (under the user's RLS view). */
  result: { tunnelId: string; capabilities: string[] } | null;
}

export interface OnpremCapsResult {
  tunnelId: string;
  capabilities: string[];
}

function readCache(request: FastifyRequest, orgId: string): CacheEntry | undefined {
  const slot = (request as unknown as Record<symbol, CacheEntry | undefined>)[CACHE_KEY];
  if (!slot) return undefined;
  if (slot.orgId !== orgId) return undefined;
  return slot;
}

function writeCache(request: FastifyRequest, entry: CacheEntry): void {
  (request as unknown as Record<symbol, CacheEntry>)[CACHE_KEY] = entry;
}

/**
 * Return the live on-prem tunnel + capabilities for an org under the current
 * request's RLS view, memoized per request. Returns null if:
 *   - The user has no membership/reseller path to the org (RLS filters out
 *     the row).
 *   - The org has no online tunnel.
 */
export async function getOnpremCapsForOrg(
  request: FastifyRequest,
  orgId: string,
): Promise<OnpremCapsResult | null> {
  const cached = readCache(request, orgId);
  if (cached !== undefined) return cached.result;

  const sql = getSql();
  const [row] = await sql<{ id: string; capabilities: string[] }[]>`
    SELECT id, capabilities
    FROM onprem_tunnels
    WHERE subtenant_id = ${orgId} AND status = 'online'
    ORDER BY last_seen DESC NULLS LAST
    LIMIT 1
  `;

  const result: OnpremCapsResult | null = row
    ? { tunnelId: row.id, capabilities: row.capabilities }
    : null;
  writeCache(request, { orgId, result });
  return result;
}

/** Test helper. */
export function _resetOnpremCapsCache(request: FastifyRequest): void {
  delete (request as unknown as Record<symbol, unknown>)[CACHE_KEY];
}
