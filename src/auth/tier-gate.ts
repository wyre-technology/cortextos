/**
 * Tier-gate helper — the wire-point primitive for the Phase-2 permission-tier
 * runtime enforcement. Sits in front of every tools/call dispatch in the proxy
 * (router.ts, cli-router.ts, unified-router.ts).
 *
 * Returns:
 *   - `{ allowed: true }` when (i) the flag is off OR (ii) the caller's tier
 *     covers the tool's required tier.
 *   - `{ allowed: false, reason }` when DENY — emits a `tier_denied` audit-event
 *     to admin_audit_log as a side-effect (best-effort; never throws). The
 *     reason is a structured discriminator so callers can map to a clean
 *     jsonRpcError message without leaking internal substrate state.
 *
 * Decision rules (FAIL-CLOSED on all unknowns):
 *   - flag-off → `{ allowed: true }` (no enforcement; provable-no-effect)
 *   - unknown OrgRole → DENY (`unresolvable-caller`)
 *   - unclassified tool → DENY (`unclassified-tool`)
 *   - caller-tier < required-tier → DENY (`insufficient-tier`)
 *
 * ActingAs: callers MUST pass the EFFECTIVE OrgRole (mapped via
 * `actingAs.effectiveRole` when an actingAs binding is active). The tier-gate
 * itself does not resolve actingAs; that's the caller's responsibility (same
 * shape as `scopeAllows`).
 */
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { getSql } from '../db/context.js';
import { tierForOrgRole } from './caller-tier.js';
import { callerCanInvoke, requiredTierForTool, type PermissionTier } from './tier-check.js';
import type { OrgRole } from '../org/org-service.js';

export type TierDeniedReason = 'unresolvable-caller' | 'unclassified-tool' | 'insufficient-tier';

export interface TierGateContext {
  /**
   * The caller's effective OrgRole for this request. For direct callers, this
   * is `membership.role`. For actingAs callers, this is
   * `actingAs.effectiveRole`. The gate does not infer; callers MUST resolve
   * before calling.
   */
  effectiveRole: OrgRole | null;
  vendorSlug: string;
  toolName: string;
  /** Auditing context. */
  orgId: string | null;
  actorId: string;
}

export interface TierGateAllow {
  allowed: true;
}

export interface TierGateDeny {
  allowed: false;
  reason: TierDeniedReason;
  callerTier: PermissionTier | null;
  requiredTier: PermissionTier | null;
}

export type TierGateResult = TierGateAllow | TierGateDeny;

/**
 * Run the tier check. When the flag is off, returns `{ allowed: true }` without
 * computing anything — provable-no-effect for the dormant-Phase-1 callers.
 *
 * When the flag is on and DENY, emits a `tier_denied` admin_audit_log event in
 * the background (best-effort; never throws). The caller is expected to map
 * the deny to a jsonRpcError response.
 */
export function tierGate(ctx: TierGateContext): TierGateResult {
  // FLAG-OFF = PROVABLE-NO-EFFECT. Test asserts this branch never reads tier
  // and never touches SQL — `getSql()` is only invoked on the deny path so
  // callers don't need a SQL context for the flag-off short-circuit.
  // Optional-chain on `features` defends against partial-config mocks; in
  // prod config.features is always defined, but tests sometimes mock config
  // with a minimal shape.
  if (!config.features?.permissionTiers) return { allowed: true };

  const callerTier = tierForOrgRole(ctx.effectiveRole);
  const requiredTier = requiredTierForTool(ctx.vendorSlug, ctx.toolName);

  if (!callerTier) {
    emitTierDenied(ctx, 'unresolvable-caller', callerTier, requiredTier);
    return { allowed: false, reason: 'unresolvable-caller', callerTier, requiredTier };
  }
  if (!requiredTier) {
    emitTierDenied(ctx, 'unclassified-tool', callerTier, requiredTier);
    return { allowed: false, reason: 'unclassified-tool', callerTier, requiredTier };
  }
  if (!callerCanInvoke(callerTier, ctx.vendorSlug, ctx.toolName)) {
    emitTierDenied(ctx, 'insufficient-tier', callerTier, requiredTier);
    return { allowed: false, reason: 'insufficient-tier', callerTier, requiredTier };
  }
  return { allowed: true };
}

/**
 * Best-effort audit emission for a tier-denial. Fire-and-forget so a transient
 * DB error never propagates to the request path. Matches the existing
 * admin_audit_log INSERT pattern in unified-router.ts:331 (also used by other
 * Phase-2-class authz events).
 */
function emitTierDenied(
  ctx: TierGateContext,
  reason: TierDeniedReason,
  callerTier: PermissionTier | null,
  requiredTier: PermissionTier | null,
): void {
  // SCOPE OF SKIP: this skip-on-no-SQL applies to the AUDIT-EMISSION ONLY.
  // The gate-DENY decision has ALREADY been made (tierGate's fail-closed checks
  // returned `{ allowed: false }` before this function ran). This function is
  // observability — the log row is for operators to review tier-denials.
  // Skipping the log when there's no SQL context (e.g. unit-test environment
  // that never entered runWithSql) leaves the gate DENY intact; it just means
  // no audit row gets written for that test invocation. This is NOT a
  // fail-open path; it's a best-effort observability emission.
  let sql;
  try {
    sql = getSql();
  } catch {
    // No SQL context (e.g. unit-test environment that never enters runWithSql).
    // The gate-DENY has already been issued; silently skip the audit log.
    return;
  }
  const metadata = {
    reason,
    vendor_slug: ctx.vendorSlug,
    tool_name: ctx.toolName,
    caller_tier: callerTier,
    required_tier: requiredTier,
    effective_role: ctx.effectiveRole,
  };
  // Don't `await` — the audit emission is observability, not correctness.
  // Failure is logged but never blocks the request-path response.
  void sql`
    INSERT INTO admin_audit_log (id, org_id, actor_id, event_type, metadata)
    VALUES (${nanoid()}, ${ctx.orgId}, ${ctx.actorId}, ${'tier_denied'}, ${sql.json(metadata)})
  `.catch(() => {
    // Swallow — the gate already DENIED the request; audit failure is
    // observability noise, not a correctness issue. Log at the caller.
  });
}

/**
 * Format a tier-deny as a jsonRpcError message string. Internal-state-clean:
 * does NOT leak the caller's resolved tier or the tool's required tier (those
 * are in the audit-event for operators to review; surface-clean for the caller).
 */
export function tierDeniedRpcMessage(reason: TierDeniedReason, toolName: string): string {
  switch (reason) {
    case 'unresolvable-caller':
      return `Tool "${toolName}" requires a resolved caller role.`;
    case 'unclassified-tool':
      return `Tool "${toolName}" is not classified for permission-tier enforcement.`;
    case 'insufficient-tier':
      return `Tool "${toolName}" requires a higher permission tier than your role permits.`;
  }
}
