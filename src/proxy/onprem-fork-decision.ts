/**
 * Unified-router on-prem fork decision logic — extracted from the inline
 * dispatch in unified-router.ts so the three (a)/(b)/(c) failure-mode
 * branches are unit-testable in isolation.
 *
 * PR #2 §4 step 5 + boss pin-1 refinement (chunk 7): the fork's logic is
 * small + well-typed, but the (b) "configured but no control-plane client →
 * do NOT fall through to cloud" branch is the easiest to silently regress
 * to (c)-with-fallthrough. Extracting + unit-testing the branch decision
 * directly pins it explicitly.
 *
 * The function is intentionally a pure decision returning a discriminated
 * `OnpremRouteDecision` — no I/O, no side effects. The caller (unified-
 * router) consults the decision and either falls through to the standard
 * cloud path or invokes `relayControlPlane.route()` per the decision.
 *
 * Inputs:
 *   - userId: from `resolveUserId(authHeader)`; svc:* identities skip the
 *     on-prem path (service clients have no user→org membership).
 *   - vendorSlug: the parsed `{vendor}__{tool}` prefix.
 *   - onpremCaps: per-request memoized result from `getOnpremCapsForOrg`.
 *     null = no live tunnel for this user's org (or RLS hid it).
 *   - hasControlPlaneClient: whether the gateway boot configured a relay
 *     control-plane client.
 */

export type OnpremRouteDecision =
  /** No on-prem path for this slug — caller falls through to cloud. */
  | { kind: 'fall_through_to_cloud' }
  /**
   * On-prem capability IS registered for this org BUT the gateway has no
   * control-plane client. Caller returns a typed JSON-RPC error; do NOT
   * fall through (operator chose on-prem; silent cloud-fallback would
   * violate the choice). Boss pin 4(b).
   */
  | { kind: 'configured_but_unreachable' }
  /**
   * On-prem capability IS registered + control-plane client present →
   * caller dispatches via control-plane. Carries the resolved tunnel
   * subtenant + tunnel id so the caller can route directly.
   */
  | { kind: 'dispatch_via_control_plane'; subtenantId: string; tunnelId: string };

export interface OnpremForkInputs {
  /** From `resolveUserId(authHeader)`; null = unauth path (rare here). */
  userId: string | null;
  /**
   * The user's primary org id from `getUserPrimaryOrgId`; null = user has
   * no orgs → no on-prem path → fall through.
   */
  orgId: string | null;
  /** Per-request memoized on-prem caps for this org, or null. */
  onpremCaps: { tunnelId: string; capabilities: string[] } | null;
  /** Exact slug from the tools/call prefix. */
  vendorSlug: string;
  /** Whether the gateway has a relay control-plane client wired. */
  hasControlPlaneClient: boolean;
}

/**
 * Decide the on-prem fork's branch. Pure function — easy to unit-test for
 * each of (a) / (b) / (c).
 *
 * The capability match is EXACT (caps.includes(slug)) per boss pin 3 — no
 * normalization, no lowercasing, no prefix-match. Same discipline as the
 * HMAC body-binding pin (verifier sees exactly what signer set).
 */
export function decideOnpremRoute(inputs: OnpremForkInputs): OnpremRouteDecision {
  // Service-client identities (svc:<orgId>:<clientId>) never take the on-prem
  // path — they have no user→org membership in the conventional sense.
  if (!inputs.userId || inputs.userId.startsWith('svc:')) {
    return { kind: 'fall_through_to_cloud' };
  }

  // No primary org → no on-prem path. Fall through.
  if (!inputs.orgId) {
    return { kind: 'fall_through_to_cloud' };
  }

  // No live tunnel registered for this org (or RLS hid it). Fall through.
  if (!inputs.onpremCaps) {
    return { kind: 'fall_through_to_cloud' };
  }

  // Capability check — EXACT slug match (pin 3).
  if (!inputs.onpremCaps.capabilities.includes(inputs.vendorSlug)) {
    // (a) — slug not in caps → no on-prem path for this vendor → fall through.
    return { kind: 'fall_through_to_cloud' };
  }

  // Capability IS registered. Now (b) vs (c).
  if (!inputs.hasControlPlaneClient) {
    // (b) — on-prem path configured but no control-plane client → typed
    // error; do NOT fall through. Operator chose on-prem; a silent cloud-
    // fallback here would violate that choice.
    return { kind: 'configured_but_unreachable' };
  }

  // (c) — dispatch via control-plane.
  return {
    kind: 'dispatch_via_control_plane',
    subtenantId: inputs.orgId,
    tunnelId: inputs.onpremCaps.tunnelId,
  };
}
