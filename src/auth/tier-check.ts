/**
 * Permission-tier check — the read/write/admin authorization layer.
 *
 * This module is the pure decision core for the 3-tier permission model. It is
 * DORMANT in Phase 1: shipped and tested, but NOT yet wired into any router. The
 * enforcement wire-up (gated behind `config.permissionTiers` / GATEWAY_PERMISSION_TIERS)
 * lands in a later phase. Wiring it earlier would have no effect while the flag is off,
 * but keeping it unwired keeps the dormant-code boundary explicit.
 *
 * Tiers are a strict superset chain: read < write < admin. The tier-check is an
 * ADDITIONAL intersection in the request path — it composes with (does not replace)
 * the per-vendor allowlist (`effectiveScope`) and credential resolution.
 *
 * FAIL-CLOSED is the load-bearing invariant: an unresolvable caller tier or an
 * unclassified tool both DENY. Never infer a tier from an unmatched/unknown tool —
 * a silent "treat unknown as read" default would let a mis-named write tool leak.
 */
import { vendorToolConfig, type ToolConfig } from '../proxy/result-cache.js';

export type PermissionTier = 'read' | 'write' | 'admin';

/** Ordinal rank. A caller may invoke a tool iff caller-rank >= tool-required-rank. */
export const TIER_LEVEL: Record<PermissionTier, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

/**
 * Map a tool's classification config to the tier required to invoke it. Pure; every
 * branch is total. `admin` outranks `write` outranks `read`. A null config (unclassified
 * tool) maps to null = FAIL-CLOSED (the caller must deny).
 */
export function tierForToolConfig(config: ToolConfig | null): PermissionTier | null {
  if (!config) return null; // FAIL-CLOSED: unclassified tool
  if (config.isAdmin) return 'admin';
  if (config.isWrite) return 'write';
  return 'read';
}

/**
 * Tier required to invoke a given (vendor, tool). Returns null for any unknown vendor
 * or tool — callers MUST treat null as deny.
 */
export function requiredTierForTool(vendorSlug: string, toolName: string): PermissionTier | null {
  return tierForToolConfig(vendorToolConfig(vendorSlug, toolName));
}

/**
 * True iff the caller's tier permits invoking the tool. FAIL-CLOSED on an unresolvable
 * caller tier (null) and on an unclassified tool (required tier null).
 */
export function callerCanInvoke(
  callerTier: PermissionTier | null,
  vendorSlug: string,
  toolName: string,
): boolean {
  if (!callerTier) return false; // FAIL-CLOSED: unresolvable caller
  const required = requiredTierForTool(vendorSlug, toolName);
  if (!required) return false; // FAIL-CLOSED: unclassified tool
  return TIER_LEVEL[callerTier] >= TIER_LEVEL[required];
}
